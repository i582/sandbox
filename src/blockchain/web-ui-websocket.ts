import {ContractMeta} from '../meta/ContractsMeta';
import {WebSocket} from 'ws';

export type ContractRawData = {
    readonly address: string;
    readonly meta: ContractMeta | undefined;
    readonly stateInit: string | undefined;
    readonly account: string | undefined;
};

export type MessageTestData = {
    readonly $: "test-data"
    readonly testName: string | undefined
    readonly transactions: string
    readonly contracts: readonly ContractRawData[]
}

export type Message = MessageTestData

export function sendToWebsocket(ws: WebSocket | undefined, data: Message): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }

    if (ws === undefined) {
        console.error('Cannot send, Websocket is undefined!');
    }
    if (ws && ws.readyState !== WebSocket.OPEN) {
        console.error('Cannot send, Websocket is not opem!');
    }
}
