// ====== Imports ======
const dgram = require('dgram');
const midi = require('midi');
const readline = require('readline');
const osc = require('osc');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// ====== CLI Options ======
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
  .option('keyboard', {
    description: 'Enable keyboard input (A–K)',
    type: 'boolean',
    default: true
  })
  .argv;

const TARGET_IP = argv.ip;
const TARGET_PORT = argv.port;
const enableKeyboard = argv.keyboard;

// ====== Global State ======
const midiInput = new midi.Input();
const midiOutput = new midi.Output();
const udpClient = dgram.createSocket('udp4');
let isGuitar = false;
let selectedMidiOut = -1;

// ====== Setup Readline for Prompts ======
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// ====== Startup Info ======
console.clear();
console.log(`🎛️ Sending OSC to ${TARGET_IP}:${TARGET_PORT}`);
console.log("🎼 Available MIDI output ports:");
for (let i = 0; i < midiOutput.getPortCount(); i++) {
  console.log(`[${i}] ${midiOutput.getPortName(i)}`);
}

// ====== OSC Receiver (Port 7000) ======
const oscServer = new osc.UDPPort({
  localAddress: "0.0.0.0",
  localPort: 7000
});

oscServer.on("ready", () => {
  console.log("📥 OSC Receiver listening on port 7000");
});

oscServer.on("message", (msg) => {
  console.log(`📨 Received OSC message: ${msg.address} ${JSON.stringify(msg.args)}`);

  if (msg.address === "/balloon/pop") {
    const [note, velocity, channel] = msg.args;
    console.log(`🎈 Balloon popped! Note=${note}, Velocity=${velocity}, Channel=${channel}`);
  }
});

oscServer.on("error", (err) => {
  console.error("❌ OSC Server Error:", err.message);
});

oscServer.open();


// ====== Prompt for MIDI Output First ======
function promptMidiOutput() {
  rl.question('Select MIDI output port for playback (or type -1 to skip): ', (answer) => {
    selectedMidiOut = parseInt(answer);

    if (selectedMidiOut >= 0) {
      midiOutput.openPort(selectedMidiOut);
      console.log(`✅ MIDI output port opened: ${midiOutput.getPortName(selectedMidiOut)}`);
    } else {
      console.log("⛔ Skipping MIDI output.");
    }

    promptMidiInput(); // ➡️ continue to input
  });
}

// ====== Prompt for MIDI Input ======
function promptMidiInput() {
  console.log("🎹 Available MIDI input ports:");
  for (let i = 0; i < midiInput.getPortCount(); i++) {
    console.log(`[${i}] ${midiInput.getPortName(i)}`);
  }

  rl.question('Select MIDI input port (or type -1 to skip): ', (answer) => {
    const selectedPort = parseInt(answer);

    if (selectedPort >= 0) {
      midiInput.openPort(selectedPort);
      const portName = midiInput.getPortName(selectedPort);
      if (portName.includes("Guitar")) isGuitar = true;

      midiInput.ignoreTypes(true, true, true);
      midiInput.on('message', (deltaTime, message) => {
        handleMidiMessage(message);
      });

      console.log(`✅ Listening on MIDI port: ${portName}`);
    } else {
      console.log("⛔ Skipping MIDI input.");
    }

    if (enableKeyboard) {
      setupKeyboardInput();
    }

    rl.close(); // done prompting
  });
}

// ====== Start Prompt Chain ======
promptMidiOutput();

// ====== MIDI Handler ======
function handleMidiMessage(message) {
  // Validate message length
  if (message.length < 3) {
    console.log(`❌ Invalid MIDI message length: ${message.length}`);
    return;
  }

  const status = message[0];
  const note = message[1];
  const velocity = message[2];
  
  // Extract channel (0-15) and message type
  let channel = status & 0x0F;
  const messageType = status & 0xF0;
  
  // Guitar channel adjustment - be more careful here
  if (isGuitar && channel >= 6) {
    channel -= 6;
  }
  
  console.log(`Raw MIDI: [${message[0]}, ${message[1]}, ${message[2]}] - Type: 0x${messageType.toString(16)}, Channel: ${channel}`);

  // Handle Note On (0x90) with velocity > 0
  if (messageType === 0x90 && velocity > 0) {
    const data = [note, velocity, channel];
    console.log(`🎵 NoteOn: Note=${note}, Velocity=${velocity}, Channel=${channel}`);
    sendOSC('/note/on', data);
    if (selectedMidiOut >= 0) {
      const noteOn = 0x90; // Note On, channel 0
      midiOutput.sendMessage([noteOn, note, 127]);
    }

  } 
  // Handle Note Off (0x80) OR Note On with velocity 0
  else if (messageType === 0x80 || (messageType === 0x90 && velocity === 0)) {
    const data = [note, 0, channel];
    console.log(`🎵 NoteOff: Note=${note}, Channel=${channel}`);
    sendOSC('/note/off', data);
  }
  // Handle Control Change (0xB0)
  else if (messageType === 0xB0) {
    const data = [note, velocity, channel]; // note = CC#, velocity = value
    console.log(`🎛️ Control Change: CC=${note}, Value=${velocity}, Channel=${channel}`);
    sendOSC('/control/change', data);
  }
  // Handle other message types
  else {
    console.log(`❓ Unhandled MIDI: [${message[0]}, ${message[1]}, ${message[2]}] - Type: 0x${messageType.toString(16)}`);
  }
}

// ====== Send OSC Message ======
function sendOSC(address, values) {
  try {
    // Validate input values
    const validatedValues = values.map(v => {
      const intValue = parseInt(v);
      if (isNaN(intValue)) {
        console.warn(`⚠️ Invalid value converted to 0: ${v}`);
        return 0;
      }
      return intValue;
    });

    // Create OSC message with explicit integer types
    const msg = {
      address: address,
      args: validatedValues.map(v => ({
        type: 'i',
        value: v
      }))
    };

    console.log(`📡 Sending OSC: ${address} [${validatedValues.join(', ')}]`);
    
    const buffer = osc.writePacket(msg);
    
    // Add a small delay to prevent message flooding
    setTimeout(() => {
      udpClient.send(buffer, TARGET_PORT, TARGET_IP, (err) => {
        if (err) {
          console.error(`❌ UDP send error: ${err.message}`);
        } else {
          console.log(`✅ OSC sent successfully: ${address}`);
        }
      });
    }, 1); // 1ms delay
    
  } catch (error) {
    console.error(`❌ OSC packet creation error: ${error.message}`);
  }
}

// ====== Keyboard Input (Optional) ======
function setupKeyboardInput() {
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  const keyMap = {
    a: 60, s: 62, d: 64, f: 65,
    g: 67, h: 69, j: 71, k: 72
  };

  const activeKeys = new Set();

  console.log("⌨️  Keyboard mode active. Press A–K for notes. Press Q to quit.");

  stdin.on('data', (key) => {
    const lowerKey = key.toLowerCase();

    if (key === '\u0003' || lowerKey === 'q') {
      console.log("👋 Exiting...");
      process.exit();
    }

    const note = keyMap[lowerKey];
    if (note !== undefined && !activeKeys.has(lowerKey)) {
      activeKeys.add(lowerKey);
      const onData = [note, 127, 0];
      console.log(`⌨️  Keyboard NoteOn: Note=${note}, Velocity=127, Channel=0`);
      sendOSC('/note/on', onData);

      setTimeout(() => {
        const offData = [note, 0, 0];
        console.log(`⌨️  Keyboard NoteOff: Note=${note}, Channel=0`);
        sendOSC('/note/off', offData);
        activeKeys.delete(lowerKey);
        if (selectedMidiOut >= 0) {
          const noteOff = 0x80; // Note Off, channel 0
          midiOutput.sendMessage([noteOff, note, 0]);
        }
      }, 200);
    }
  });
}

// ====== Graceful Shutdown ======
process.on("SIGINT", () => {
  console.log("\n🧹 Cleaning up...");
  try { 
    midiInput.closePort(); 
  } catch (e) {
    console.log("MIDI port already closed");
  }
  udpClient.close();
  process.exit();
});