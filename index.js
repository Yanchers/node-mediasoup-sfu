"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const mediasoup_1 = require("mediasoup");
const ws_1 = require("ws");
const app = (0, express_1.default)();
const server = require("http").createServer(app);
const wss = new ws_1.WebSocketServer({ server });
let worker, router;
let channels = {};
// let channels: {
// 	[id: string]: {
// 		users: unknown[];
// 		producers: { [id: string]: unknown };
// 		consumers: { [id: string]: unknown };
// 	};
// } = {}; // Список каналов {channelName: { users, producers, consumers }}
const peers = [];
// Инициализация MediaSoup
async function startMediasoup() {
    worker = await (0, mediasoup_1.createWorker)();
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
let id_gen = 1;
wss.on("connection", async (ws) => {
    const peer = {
        id: id_gen++,
        ws: ws,
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
                // if (!channels[data.channel]) {
                // 	channels[data.channel] = { users: [], producers: {}, consumers: {} };
                // }
                channels[data.channel].users[data.userId] = {
                    consumers: [],
                    producers: [],
                    user: peer,
                };
                ws.send(JSON.stringify({ type: "channelJoined", channel: data.channel }));
                break;
            case "getRouterCapabilities":
                ws.send(JSON.stringify({
                    type: "routerCapabilities",
                    rtpCapabilities: router.rtpCapabilities,
                }));
                break;
            case "createTransport":
                const sendtransport = await router.createWebRtcTransport({
                    listenInfos: [
                        {
                            ip: "192.168.0.3",
                            protocol: "udp",
                            announcedAddress: "192.168.0.3",
                        },
                    ],
                });
                const recvtransport = await router.createWebRtcTransport({
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
                ws.send(JSON.stringify({
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
                }));
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
                peer.ws.send(JSON.stringify({
                    type: "producerCreated",
                    producerId: producer.id,
                }));
                // notify sender about existing producers
                Object.keys(channels[data.channel].users).forEach((key) => {
                    if (key == data.userId)
                        return;
                    channels[data.channel].users[key].producers.forEach((prod) => {
                        if (channels[data.channel].users[data.userId].consumers.some((c) => c.producerId == prod.id))
                            return;
                        channels[data.channel].users[data.userId].user.ws.send(JSON.stringify({
                            type: "newProducer",
                            producerId: prod.id,
                        }));
                    });
                });
                // Уведомить всех пользователей в канале о новом потоке
                Object.keys(channels[data.channel].users).forEach((key) => {
                    if (key == data.userId)
                        return;
                    channels[data.channel].users[key].user.ws.send(JSON.stringify({ type: "newProducer", producerId: producer.id }));
                });
                // channels[data.channel].users.forEach((client) => {
                // 	if (client == peer.ws) return;
                // 	(client as WebSocket).send(
                // 		JSON.stringify({ type: "newProducer", producerId: producer.id })
                // 	);
                // });
                break;
            case "consume":
                const producerId = data.producerId;
                if (!producerId)
                    return;
                // @ts-ignore
                const consumer = await peer.recvTransport.consume({
                    producerId,
                    rtpCapabilities: data.rtpCapabilities,
                    paused: true,
                });
                channels[data.channel].users[data.userId].consumers.push(consumer);
                setTimeout(() => {
                    consumer.resume();
                }, 2000);
                channels[data.channel].users[data.userId].user.ws.send(JSON.stringify({
                    type: "consumerCreated",
                    consumeParams: {
                        id: consumer.id,
                        producerId: consumer.producerId,
                        kind: consumer.kind,
                        rtpParameters: consumer.rtpParameters,
                    },
                }));
                break;
            case "leaveChannel":
                // if (channels[data.channel]) {
                // 	channels[data.channel].users = channels[data.channel].users.filter(
                // 		(client) => client !== ws
                // 	);
                // 	delete channels[data.channel].producers[data.clientId];
                // 	delete channels[data.channel].consumers[data.clientId];
                // 	// Удалить канал, если в нем никого не осталось
                // 	if (channels[data.channel].users.length === 0) {
                // 		delete channels[data.channel];
                // 	}
                // }
                break;
        }
    });
    ws.on("close", () => {
        // for (let channel in channels) {
        // 	channels[channel].users = channels[channel].users.filter(
        // 		(client) => client !== ws
        // 	);
        // }
    });
});
server.listen(3000, () => console.log("Server started on port 3000"));
startMediasoup();
