import React, { useEffect } from 'react';
import Sidebar from './Sidebar';
import Header from './Header';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { websocketService } from '../../services/websocketService';
import { useAuth } from '../../contexts/AuthContext';
import { logService } from '../../services/logService';
import { api } from '../../services/mockApi';
import { scannerStore } from '../../services/scannerStore';
import { useAppContext } from '../../contexts/AppContext';
import { useSidebar } from '../../contexts/SidebarContext';


const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { setConnectionStatus } = useWebSocket();
  const { isAuthenticated } = useAuth();
  const { settingsActivityCounter, refreshData, setSettings, setCircuitBreakerStatus, setFearAndGreed } = useAppContext();
  const { isCollapsed, isMobileOpen, setMobileOpen } = useSidebar();

  useEffect(() => {
    if (isAuthenticated) {
        logService.log('INFO', "User is authenticated, initializing data and WebSocket...");
        websocketService.onStatusChange(setConnectionStatus);
        websocketService.onDataRefresh(refreshData);
        websocketService.onCircuitBreakerUpdate((payload) => setCircuitBreakerStatus(payload.status));
        websocketService.onFearAndGreedUpdate(setFearAndGreed);
        websocketService.connect();
        
        const initializeAndFetchData = async () => {
            try {
                logService.log('INFO', 'Fetching settings and initializing...');
                const settingsData = await api.fetchSettings();
                setSettings(settingsData);
                scannerStore.updateSettings(settingsData);
                scannerStore.initialize();

                // The initial scanner list will now be populated via WebSocket request
                // after the connection is established. This is more reliable.
            } catch (error) {
                logService.log('ERROR', `Failed to initialize app data: ${error}`);
            }
        };
        initializeAndFetchData();
    } else {
        logService.log('INFO', "User is not authenticated, disconnecting WebSocket.");
        websocketService.disconnect();
    }
    
    return () => {
      if (!isAuthenticated) {
          websocketService.disconnect();
      }
      websocketService.onStatusChange(null);
      websocketService.onDataRefresh(null);
      websocketService.onCircuitBreakerUpdate(null);
      websocketService.onFearAndGreedUpdate(null);
    };
  }, [isAuthenticated, setConnectionStatus, settingsActivityCounter, refreshData, setSettings, setCircuitBreakerStatus, setFearAndGreed]);

  return (
    <div className="flex h-screen bg-[#0c0e12] overflow-hidden">
      <Sidebar />
      
      {isMobileOpen && (
        <div 
          className="fixed inset-0 bg-black/60 z-40 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        ></div>
      )}

      <div className="flex-1 flex flex-col overflow-hidden relative">
        <Header />
        <main className="flex-1 overflow-y-auto bg-[#0c0e12] p-4 sm:p-6 lg:p-8">
            <div className="w-full">
                {children}
            </div>
        </main>
      </div>
    </div>
  );
};

export default Layout;
