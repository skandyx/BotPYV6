import { BotSettings, Trade, TradingMode } from '../types';
import { logService } from './logService';

const API_BASE_URL = '/api';

const handleResponse = async (response: Response) => {
    if (response.status === 204) {
        return;
    }
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.message || `HTTP error! status: ${response.status}`);
    }
    return data;
};

const apiFetch = async (endpoint: string, options: RequestInit = {}) => {
    const method = options.method || 'GET';
    const url = `${API_BASE_URL}${endpoint}`;
    
    logService.log('API_CLIENT', `[REQ] ${method} ${endpoint}`);
    try {
        const response = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers,
            },
            credentials: 'include', // Important for session cookies
        });
        const result = await handleResponse(response);
        logService.log('API_CLIENT', `[RES OK] ${method} ${endpoint} - Status: ${response.status}`);
        return result;
    } catch (error) {
        logService.log('ERROR', `[RES ERR] ${method} ${endpoint} - Error: ${error}`);
        throw error;
    }
};


export const api = {
    // Auth
    login: async (password: string): Promise<{ success: boolean, message: string }> => {
        return apiFetch('/login', {
            method: 'POST',
            body: JSON.stringify({ password })
        });
    },
    logout: async (): Promise<void> => {
        await apiFetch('/logout', { method: 'POST' });
    },
    checkSession: async (): Promise<{ isAuthenticated: boolean }> => {
        return apiFetch('/check-session');
    },
    changePassword: async (newPassword: string): Promise<{ success: boolean, message: string }> => {
        return apiFetch('/change-password', {
            method: 'POST',
            body: JSON.stringify({ newPassword })
        });
    },

    // Settings
    fetchSettings: async (): Promise<BotSettings> => {
        return apiFetch('/settings');
    },
    updateSettings: async (settings: Partial<BotSettings>): Promise<{ success: boolean }> => {
        return apiFetch('/settings', {
            method: 'POST',
            body: JSON.stringify(settings)
        });
    },

    // Data
    fetchBotStatus: async () => {
        return apiFetch('/status');
    },
    fetchActivePositions: async () => {
        return apiFetch('/positions');
    },
    fetchTradeHistory: async () => {
        return apiFetch('/history');
    },
    fetchPerformanceStats: async () => {
        return apiFetch('/performance-stats');
    },
    fetchScannedPairs: async () => {
        return apiFetch('/scanner');
    },

    // Actions
    openTrade: async (symbol: string, price: number, mode: TradingMode): Promise<Trade> => {
        return apiFetch('/open-trade', {
            method: 'POST',
            body: JSON.stringify({ symbol, price, mode })
        });
    },
    closeTrade: async (tradeId: number): Promise<Trade> => {
        return apiFetch(`/close-trade/${tradeId}`, { method: 'POST' });
    },
    clearAllTradeData: async (): Promise<{ success: boolean }> => {
        return apiFetch('/clear-data', { method: 'POST' });
    },
    testBinanceConnection: async (apiKey: string, secretKey: string): Promise<{ success: boolean, message: string }> => {
        return apiFetch('/test-connection', {
            method: 'POST',
            body: JSON.stringify({ apiKey, secretKey })
        });
    },

    // Bot Control
    getBotRunStatus: async (): Promise<{ isRunning: boolean }> => {
        return apiFetch('/bot/status');
    },
    startBot: async (): Promise<{ success: boolean }> => {
        return apiFetch('/bot/start', { method: 'POST' });
    },
    stopBot: async (): Promise<{ success: boolean }> => {
        return apiFetch('/bot/stop', { method: 'POST' });
    },
    fetchTradingMode: async (): Promise<{ mode: TradingMode }> => {
        return apiFetch('/mode');
    },
    updateTradingMode: async (mode: TradingMode): Promise<{ success: boolean, mode: TradingMode }> => {
        return apiFetch('/mode', {
            method: 'POST',
            body: JSON.stringify({ mode })
        });
    },
};