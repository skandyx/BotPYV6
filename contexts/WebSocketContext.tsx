
import React, { createContext, useState, useContext, ReactNode } from 'react';
import { WebSocketStatus } from '../types';

interface WebSocketContextType {
  connectionStatus: WebSocketStatus;
  setConnectionStatus: (status: WebSocketStatus) => void;
}

const WebSocketContext = createContext<WebSocketContextType | undefined>(undefined);

export const WebSocketProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [connectionStatus, setConnectionStatus] = useState<WebSocketStatus>(WebSocketStatus.DISCONNECTED);

  return (
    <WebSocketContext.Provider value={{ connectionStatus, setConnectionStatus }}>
      {children}
    </WebSocketContext.Provider>
  );
};

export const useWebSocket = (): WebSocketContextType => {
  const context = useContext(WebSocketContext);
  if (context === undefined) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};
