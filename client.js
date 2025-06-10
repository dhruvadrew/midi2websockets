const WebSocket = require('ws');
const dgram = require('dgram');
const midi = require('midi');
const readline = require('readline');
const osc = require('osc');

const useWebSocket = false; // <<== Toggle between WebSocket and OSC over UDP

const midiInput = new midi.Input();
let ws = null;
let udpClient = null;

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
});

console.clear();
let weAreConnected = false;
var isGuitar = false;

rl.question('What internet port would you like to use (3902/3907)? ', (answer) => {
	var internetPort = parseInt(answer);

	if (!useWebSocket) {
		udpClient = dgram.createSocket('udp4');
		console.log(`OSC UDP client initialized. Will send to 199.19.73.131:${internetPort}`);
	}

	console.log("midi input (transmit) available: ");
	for (let i = 0; i < midiInput.getPortCount(); i++) {
		console.log("[" + i + "] " + midiInput.getPortName(i));
	}

	rl.question('What midi port would you like to use? ', (answer) => {
		var userSelection = parseInt(answer);
		midiInput.openPort(userSelection);
		var portName = midiInput.getPortName(userSelection);
		if (portName.includes("Guitar")) {
			isGuitar = true;
		}

		midiInput.ignoreTypes(true, true, true); 	// Order: (Sysex, Timing, Active Sensing)
		midiInput.on('message', (deltaTime, message) => {
			command = message[0];
			note = message[1];
			vel = message[2];

			let channel = command & 0x0F;
			if (!isGuitar || (isGuitar && channel > 0)) {

				if (isGuitar) {
					channel -= 6; // get in range 0-5
				}

				if ((command & 0xF0) === 0x90) { // note on message
					let altspaceMessage = "[" + note + "," + vel + "]";
					if (isGuitar) {
						altspaceMessage = "[" + note + "," + vel + "," + channel + "]";
					}
					console.log(`NoteOn: ${altspaceMessage}`);

					let sendMessage = [note, vel, channel];

					sendOutMessage('/note/on', sendMessage, internetPort);
				}

				if ((command & 0xF0) === 0x80) { // note off message
					vel = 0;
					let altspaceMessage = "[" + note + "," + vel + "]";
					if (isGuitar) {
						altspaceMessage = "[" + note + "," + vel + "," + channel + "]";
					}
					console.log(`NoteOff: ${altspaceMessage}`);

					let sendMessage = [note, vel, channel];

					sendOutMessage('/note/off', sendMessage, internetPort);
				}

				if ((command & 0xF0) === 0xB0) { // note CC
					console.log(`CC: ${message}`);
				}
			}
		});

		if (useWebSocket) {
			setInterval(() => {
				if (ws === null) {
					console.log("------------------------------------------------------------");
					console.log("1 seconds has expired. trying to connect to server... ");
					connectToServer(internetPort);
				}
			}, 1000);
		}
	});
});

function sendOutMessage(oscAddress, dataArray, port) {
	if (useWebSocket && ws && weAreConnected) {
		try {
			ws.send(JSON.stringify(dataArray));
		} catch (err) {
			console.log("can't send note right now: we don't seem to be connected");
		}
	} else if (!useWebSocket && udpClient) {
		const oscMessage = {
			address: oscAddress,
			args: dataArray.map(val => ({ type: "i", value: val }))
		};
		const buffer = osc.writePacket(oscMessage);

		udpClient.send(buffer, port, '199.19.73.131', (err) => {
			if (err) console.log("UDP/OSC send error:", err.message);
		});
	}
}

function connectToServer(port) {
	ws = new WebSocket('ws://199.19.73.131' + ':' + port);

	ws.on('error', (error) => {
		console.log("ERROR: couldn't connect to remote server.");
		weAreConnected = false;
		ws = null;
	});

	ws.on('close', (code, reason) => {
		console.log("CLOSE: connection closed");
		weAreConnected = false;
		ws = null;
	});

	ws.on('open', () => {
		weAreConnected = true;
		console.log("Success! we are connected to server!");
	});
}

process.on("SIGINT", () => {
	console.log("received SIGINT (control-c). shutting down gracefully");

	try {
		midiInput.closePort();
	} catch (err) {
		// ignore
	}

	try {
		if (ws) ws.terminate();
	} catch (err) {
		// ignore
	}

	try {
		if (udpClient) udpClient.close();
	} catch (err) {
		// ignore
	}

	process.exit();
});
