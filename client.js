// ====== Imports ======
const WebSocket = require('ws');
const dgram = require('dgram');
const midi = require('midi');
const readline = require('readline');
const osc = require('osc');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// ====== CLI Interface ======
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// ====== Command-line Arguments ======
const argv = yargs(hideBin(process.argv))
  .option('ip', {
    alias: 'i',
    description: 'Target IP address',
    type: 'string',
    default: '192.168.12.244',
  })
  .option('port', {
    alias: 'p',
    description: 'Target port',
    type: 'number',
    default: 3907,
  })
  .option('ws', {
    description: 'Use WebSocket (default is UDP)',
    type: 'boolean',
    default: false
  })
  .option('keyboard', {
    description: 'Enable keyboard MIDI input',
    type: 'boolean',
    default: true
  })
  .argv;

const TARGET_IP = argv.ip;
const TARGET_PORT = argv.port;
const useWebSocket = argv.ws;
const enableKeyboard = argv.keyboard;

// ====== Global State ======
const midiInput = new midi.Input();
let ws = null;
let udpClient = null;
let weAreConnected = false;
let isGuitar = false;

// ====== Initialization ======
console.clear();
console.log(`Using ${useWebSocket ? 'WebSocket' : 'OSC/UDP'} → ${TARGET_IP}:${TARGET_PORT}`);

// ====== UDP Setup ======
if (!useWebSocket) {
  udpClient = dgram.createSocket('udp4');
}

// ====== MIDI Setup ======
console.log("Available MIDI input ports:");
for (let i = 0; i < midiInput.getPortCount(); i++) {
  console.log(`[${i}] ${midiInput.getPortName(i)}`);
}

rl.question('Select MIDI port (or type -1 to skip): ', (answer) => {
  const selectedPort = parseInt(answer);

  if (selectedPort >= 0) {
    midiInput.openPort(selectedPort);
    const portName = midiInput.getPortName(selectedPort);
    if (portName.includes("Guitar")) isGuitar = true;

    midiInput.ignoreTypes(true, true, true);

    midiInput.on('message', (deltaTime, message) => {
      handleMidiMessage(message);
    });
  }

  if (enableKeyboard) {
    setupKeyboardInput();
  }

  if (useWebSocket) {
    connectToServer();
  }
});

// ====== MIDI Message Handler ======
function handleMidiMessage(message) {
  const command = message[0];
  let note = message[1];
  let vel = message[2];
  let channel = command & 0x0F;

  if (!isGuitar || (isGuitar && channel > 0)) {
    if (isGuitar) channel -= 6;

    let sendMessage = [note, vel, channel];
    let msgType = null;

    switch (command & 0xF0) {
      case 0x90:
        msgType = '/note/on';
        console.log(`NoteOn: [${sendMessage}]`);
        break;
      case 0x80:
        msgType = '/note/off';
        sendMessage[1] = 0;
        console.log(`NoteOff: [${sendMessage}]`);
        break;
      case 0xB0:
        console.log(`Control Change: ${message}`);
        return;
    }

    if (msgType) {
      sendOutMessage(msgType, sendMessage);
    }
  }
}

// ====== Send MIDI via WebSocket or UDP ======
function sendOutMessage(oscAddress, dataArray) {
  console.log("yup");
  if (useWebSocket && ws && weAreConnected) {
    try {
      ws.send(JSON.stringify(dataArray));
    } catch (err) {
      console.warn("WebSocket send failed:", err.message);
    }
  } else if (!useWebSocket && udpClient) {
    console.log("here");
    const oscMessage = {
      address: oscAddress,
      args: dataArray.map(val => ({ type: "i", value: val }))
    };
    const buffer = osc.writePacket(oscMessage);
    udpClient.send(buffer, TARGET_PORT, TARGET_IP, (err) => {
      if (err) console.error("UDP send error:", err.message);
    });
  }
}

// ====== WebSocket Connection ======
function connectToServer() {
  console.log("Connecting to WebSocket server...");

  ws = new WebSocket(`ws://${TARGET_IP}:${TARGET_PORT}`);

  ws.on('open', () => {
    weAreConnected = true;
    console.log("✅ WebSocket connected");
  });

  ws.on('close', () => {
    console.log("WebSocket connection closed");
    ws = null;
    weAreConnected = false;
  });

  ws.on('error', (err) => {
    console.error("WebSocket error:", err.message);
    ws = null;
    weAreConnected = false;
    setTimeout(connectToServer, 1000); // retry
  });
}

// ====== Keyboard MIDI Input (Optional) ======
function setupKeyboardInput() {
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  const keyMap = {
    a: 60, // Middle C
    s: 62,
    d: 64,
    f: 65,
    g: 67,
    h: 69,
    j: 71,
    k: 72 // C above
  };

  console.log("Keyboard mode active. Press A–K for notes. Press Q to quit.");

  stdin.on('data', (key) => {
    if (key === '\u0003' || key.toLowerCase() === 'q') {
      console.log("Exiting...");
      process.exit();
    }

    const note = keyMap[key.toLowerCase()];
    if (note !== undefined) {
      let message = [note, 127, 0]; // channel 0
      console.log(`Keyboard NoteOn: ${message}`);
      sendOutMessage('/note/on', message);

      setTimeout(() => {
        message[1] = 0; // velocity 0 = note off
        sendOutMessage('/note/off', message);
      }, 200); // auto note-off after 200ms
    }
  });
}

// ====== Graceful Exit ======
process.on("SIGINT", () => {
  console.log("\nGracefully shutting down...");
  try { midiInput.closePort(); } catch (e) {}
  if (ws) ws.terminate();
  if (udpClient) udpClient.close();
  process.exit();
});
