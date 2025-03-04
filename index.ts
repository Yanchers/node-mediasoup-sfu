import express from "express";
import { createWorker } from "mediasoup";
import {
	AppData,
	Worker,
	Router,
	Consumer,
	Producer,
} from "mediasoup/node/lib/types.js";
import { WebRtcTransport } from "mediasoup/node/lib/WebRtcTransportTypes.js";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";

interface Peer {
	userId: string;
	id: number;
	ws: WebSocket;
	sendTransport?: WebRtcTransport;
	recvTransport?: WebRtcTransport;
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

let worker: Worker<AppData>, router: Router<AppData>;
interface Channels {
	[channelId: string]: {
		users: {
			[userId: string]: {
				user: Peer;
				producers: Producer[];
				consumers: Consumer[];
			};
		};
	};
}
let channels: Channels = {};
// let channels: {
// 	[id: string]: {
// 		users: unknown[];
// 		producers: { [id: string]: unknown };
// 		consumers: { [id: string]: unknown };
// 	};
// } = {}; // Список каналов {channelName: { users, producers, consumers }}
const peers: Peer[] = [];

// Инициализация MediaSoup
async function startMediasoup() {
	worker = await createWorker();
	router = await worker.createRouter({
		mediaCodecs: [
			{
				kind: "video",
				mimeType: "audio/opus",
				clockRate: 48000,
				channels: 2,
				rtcpFeedback: [{ type: "nack" }, { type: "transport-cc" }],
			},
			{
				kind: "video",
				mimeType: "video/VP8",
				clockRate: 90000,
				rtcpFeedback: [
					{ type: "nack" },
					{ type: "nack", parameter: "pli" },
					{ type: "ccm", parameter: "fir" },
					{ type: "goog-remb" },
					{ type: "transport-cc" },
				],
			},
		],
	});
}
let id_gen: number = 1;
wss.on("connection", async (ws: WebSocket) => {
	const peer: Peer = {
		id: id_gen++,
		ws: ws,
		userId: "",
	};
	peers.push(peer);
	ws.on("message", async (message) => {
		const data = JSON.parse(message.toString());
		console.log(data.type);

		switch (data.type) {
			case "joinChannel":
				if (!channels[data.channel]) {
					channels[data.channel] = { users: {} };
				}
				peer.userId = data.userId;
				channels[data.channel].users[data.userId] = {
					consumers: [],
					producers: [],
					user: peer,
				};
				ws.send(
					JSON.stringify({ type: "channelJoined", channel: data.channel })
				);
				break;

			case "getRouterCapabilities":
				ws.send(
					JSON.stringify({
						type: "routerCapabilities",
						rtpCapabilities: router.rtpCapabilities,
					})
				);
				break;

			case "createTransport":
				const sendtransport: WebRtcTransport<AppData> =
					await router.createWebRtcTransport({
						listenInfos: [
							{
								ip: "192.168.0.3",
								protocol: "udp",
								announcedAddress: "192.168.0.3",
							},
						],
					});
				const recvtransport: WebRtcTransport<AppData> =
					await router.createWebRtcTransport({
						listenInfos: [
							{
								ip: "192.168.0.3",
								protocol: "udp",
								announcedAddress: "192.168.0.3",
							},
						],
					});
				peer.sendTransport = sendtransport;

				peer.recvTransport = recvtransport;

				ws.send(
					JSON.stringify({
						type: "transportCreated",
						sendParams: {
							id: sendtransport.id,
							iceParameters: sendtransport.iceParameters,
							iceCandidates: sendtransport.iceCandidates,
							dtlsParameters: sendtransport.dtlsParameters,
							sctpParameters: sendtransport.sctpParameters,
						},
						recvParams: {
							id: recvtransport.id,
							iceParameters: recvtransport.iceParameters,
							iceCandidates: recvtransport.iceCandidates,
							dtlsParameters: recvtransport.dtlsParameters,
							sctpParameters: recvtransport.sctpParameters,
						},
					})
				);
				break;

			case "transportConnect":
				if (data.isSend)
					await peer.sendTransport.connect({
						dtlsParameters: data.dtlsParameters,
					});
				else {
					await peer.recvTransport.connect({
						dtlsParameters: data.dtlsParameters,
					});
				}
				break;

			case "produce":
				const producer = await peer.sendTransport.produce({
					kind: data.kind,
					rtpParameters: data.rtpParameters,
				});
				channels[data.channel].users[data.userId].producers.push(producer);

				// notify sender that producer was created
				peer.ws.send(
					JSON.stringify({
						type: "producerCreated",
						producerId: producer.id,
					})
				);
				// notify sender about existing producers
				Object.keys(channels[data.channel].users).forEach((key) => {
					if (key == data.userId) return;
					channels[data.channel].users[key].producers.forEach((prod) => {
						if (
							channels[data.channel].users[data.userId].consumers.some(
								(c) => c.producerId == prod.id
							)
						)
							return;
						channels[data.channel].users[data.userId].user.ws.send(
							JSON.stringify({
								type: "newProducer",
								producerId: prod.id,
							})
						);
					});
				});
				// Уведомить всех пользователей в канале о новом потоке
				Object.keys(channels[data.channel].users).forEach((key) => {
					if (key == data.userId) return;
					channels[data.channel].users[key].user.ws.send(
						JSON.stringify({ type: "newProducer", producerId: producer.id })
					);
				});
				break;

			case "consume":
				const producerId = data.producerId;
				if (!producerId) return;

				const consumer = await peer.recvTransport.consume({
					producerId,
					rtpCapabilities: data.rtpCapabilities,
					paused: true,
				});
				channels[data.channel].users[data.userId].consumers.push(consumer);
				setTimeout(() => {
					// TODO: wait for some sort of response from user and resume consumer
					consumer.resume();
				}, 2000);

				channels[data.channel].users[data.userId].user.ws.send(
					JSON.stringify({
						type: "consumerCreated",
						consumeParams: {
							id: consumer.id,
							producerId: consumer.producerId,
							kind: consumer.kind,
							rtpParameters: consumer.rtpParameters,
						},
					})
				);
				break;

			case "leaveChannel":
				if (channels[data.channel]) {
					channels[data.channel].users[data.userId].consumers.forEach((c) =>
						c.close()
					);
					channels[data.channel].users[data.userId].producers.forEach((p) =>
						p.close()
					);
					delete channels[data.channel].users[data.userId];

					if (Object.keys(channels[data.channel].users).length == 0) {
						delete channels[data.channel];
					}
				}
				break;
		}
	});

	ws.on("close", (code, reason) => {
		console.log("Websocket disconnect: ", code, reason.toString("utf-8"));
		for (let channel in channels) {
			delete channels[channel].users[peer.userId];
		}
	});
});

server.listen({ port: 3000 }, () => console.log("Server started on port 3000"));
startMediasoup();
