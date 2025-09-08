import { WebSocketStatus, LogEntry, CircuitBreakerStatus, FearAndGreed } from '../types';
import { logService } from './logService';
import { priceStore } from './priceStore';
import { scannerStore } from './scannerStore';

export interface PriceUpdate {
    symbol: string;
    price: number;
}

type StatusChangeCallback = (status: WebSocketStatus) => void;
type DataRefreshCallback = () => void;
type CircuitBreakerCallback = (payload: { status: CircuitBreakerStatus }) => void;
type FearAndGreedCallback = (payload: FearAndGreed) => void;

let socket: WebSocket | null = null;
let statusCallback: StatusChangeCallback | null = null;
let dataRefreshCallback: DataRefreshCallback | null = null;
let circuitBreakerCallback: CircuitBreakerCallback | null = null;
let fearAndGreedCallback: FearAndGreedCallback | null = null;
let reconnectTimeout: number | null = null;
let isManualDisconnect = false;

const getWebSocketURL = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    return `${protocol}//${host}/ws`;
};

const connect = () => {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        logService.log('WEBSOCKET', 'Connection attempt ignored, socket already open or connecting.');
        return;
    }
    isManualDisconnect = false;
    if (reconnectTimeout) clearTimeout(reconnectTimeout);

    const url = getWebSocketURL();
    logService.log('WEBSOCKET', `Connecting to backend at ${url}...`);
    statusCallback?.(WebSocketStatus.CONNECTING);
    socket = new WebSocket(url);

    socket.onopen = () => {
        logService.log('WEBSOCKET', 'Successfully connected to backend.');
        statusCallback?.(WebSocketStatus.CONNECTED);

        // Request the full, current state of the scanner from the backend
        if (socket && socket.readyState === WebSocket.OPEN) {
             socket.send(JSON.stringify({ type: 'GET_FULL_SCANNER_LIST' }));
        }
    };

    socket.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            switch (message.type) {
                case 'FULL_SCANNER_LIST':
                    logService.log('WEBSOCKET', `Received full scanner list with ${message.payload.length} pairs.`);
                    scannerStore.updatePairList(message.payload);
                    break;
                case 'PRICE_UPDATE':
                    priceStore.updatePrice(message.payload);
                    break;
                case 'SCANNER_UPDATE':
                    scannerStore.handleScannerUpdate(message.payload);
                    break;
                case 'POSITIONS_UPDATED':
                    logService.log('TRADE', 'Positions updated by backend, triggering data refresh...');
                    dataRefreshCallback?.();
                    break;
                case 'CIRCUIT_BREAKER_UPDATE':
                    logService.log('WARN', `Circuit breaker status updated: ${JSON.stringify(message.payload)}`);
                    circuitBreakerCallback?.(message.payload);
                    break;
                case 'FEAR_AND_GREED_UPDATE':
                    fearAndGreedCallback?.(message.payload);
                    break;
                case 'BOT_STATUS_UPDATE':
                    logService.log('INFO', `Bot running state is now: ${message.payload.isRunning}`);
                    break;
                case 'LOG_ENTRY':
                    const logPayload = message.payload as LogEntry;
                    logService.log(logPayload.level, logPayload.message);
                    break;
                default:
                    logService.log('WEBSOCKET', `Received unknown message type: ${message.type}`);
            }
        } catch (error) {
            logService.log('ERROR', `Failed to parse WebSocket message: ${event.data}`);
        }
    };

    socket.onclose = () => {
        statusCallback?.(WebSocketStatus.DISCONNECTED);
        socket = null;
        if (!isManualDisconnect) {
            logService.log('WARN', 'WebSocket disconnected from backend. Attempting to reconnect in 5s...');
            reconnectTimeout = window.setTimeout(connect, 5000);
        } else {
            logService.log('INFO', 'WebSocket disconnected manually.');
        }
    };

    socket.onerror = (error) => {
        logService.log('ERROR', `WebSocket error: ${(error as Event).type}. Closing socket.`);
        statusCallback?.(WebSocketStatus.DISCONNECTED);
        socket?.close();
    };
};

const disconnect = () => {
    isManualDisconnect = true;
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    if (socket) {
        socket.close();
        socket = null;
    }
};

export const websocketService = {
    connect,
    disconnect,
    onStatusChange: (callback: StatusChangeCallback | null) => {
        statusCallback = callback;
    },
    onDataRefresh: (callback: DataRefreshCallback | null) => {
        dataRefreshCallback = callback;
    },
    onCircuitBreakerUpdate: (callback: CircuitBreakerCallback | null) => {
        circuitBreakerCallback = callback;
    },
    onFearAndGreedUpdate: (callback: FearAndGreedCallback | null) => {
        fearAndGreedCallback = callback;
    }
};
