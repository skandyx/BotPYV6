import React, { createContext, useState, useContext, ReactNode, useCallback } from 'react';
import { api } from '../services/mockApi';
import { positionService } from '../services/positionService';
import { logService } from '../services/logService';
import { BotSettings, CircuitBreakerStatus, FearAndGreed } from '../types';

interface AppContextType {
  tradeActivityCounter: number;
  refreshData: () => void;
  settingsActivityCounter: number;
  incrementSettingsActivity: () => void;
  settings: BotSettings | null;
  setSettings: React.Dispatch<React.SetStateAction<BotSettings | null>>;
  circuitBreakerStatus: CircuitBreakerStatus;
  setCircuitBreakerStatus: React.Dispatch<React.SetStateAction<CircuitBreakerStatus>>;
  fearAndGreed: FearAndGreed | null;
  setFearAndGreed: React.Dispatch<React.SetStateAction<FearAndGreed | null>>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [tradeActivityCounter, setTradeActivityCounter] = useState(0);
  const [settingsActivityCounter, setSettingsActivityCounter] = useState(0);
  const [settings, setSettings] = useState<BotSettings | null>(null);
  const [circuitBreakerStatus, setCircuitBreakerStatus] = useState<CircuitBreakerStatus>('NONE');
  const [fearAndGreed, setFearAndGreed] = useState<FearAndGreed | null>(null);

  const refreshData = useCallback(async () => {
    logService.log('INFO', 'WebSocket triggered position refresh. Fetching fresh data...');
    try {
        const freshPositions = await api.fetchActivePositions();
        positionService.setPositions(freshPositions);
        setTradeActivityCounter(prev => prev + 1);
    } catch (error) {
        logService.log('ERROR', `Failed to refresh positions: ${error}`);
    }
  }, []);
  
  const incrementSettingsActivity = useCallback(() => {
    setSettingsActivityCounter(prev => prev + 1);
  }, []);

  return (
    <AppContext.Provider value={{ 
        tradeActivityCounter, refreshData, 
        settingsActivityCounter, incrementSettingsActivity, 
        settings, setSettings, 
        circuitBreakerStatus, setCircuitBreakerStatus,
        fearAndGreed, setFearAndGreed
    }}>
      {children}
    </AppContext.Provider>
  );
};

export const useAppContext = (): AppContextType => {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
};
