import React, { useState, useEffect, useRef } from 'react';
import { logService } from '../services/logService';
import { LogEntry, LOG_LEVELS, LogTab } from '../types';

const TABS: Readonly<LogTab[]> = ['ALL', ...LOG_LEVELS];

const ConsolePage: React.FC = () => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [activeTab, setActiveTab] = useState<LogTab>('ALL');
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Effect to reload logs from the service when the active tab changes.
  useEffect(() => {
    setLogs(logService.getLogs(activeTab));
  }, [activeTab]);

  // Effect to handle live log updates. It re-subscribes when the active tab
  // changes to ensure the closure captures the correct `activeTab` value.
  useEffect(() => {
    const handleNewLog = (newLog: LogEntry) => {
      if (activeTab === 'ALL' || activeTab === newLog.level) {
        setLogs(prevLogs => [...prevLogs.slice(-499), newLog]);
      }
    };

    logService.subscribe(handleNewLog);

    return () => {
      logService.unsubscribe(handleNewLog);
    };
  }, [activeTab]);

  // Effect to scroll to the top to show the latest log first
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = 0;
    }
  }, [logs, activeTab]);

  const getLogLevelClass = (level: LogEntry['level']) => {
    switch (level) {
      case 'INFO': return 'text-cyan-400';
      case 'API_CLIENT': return 'text-pink-400';
      case 'WARN': return 'text-yellow-400';
      case 'ERROR': return 'text-red-400';
      case 'TRADE': return 'text-green-400';
      case 'WEBSOCKET': return 'text-purple-400';
      case 'SCANNER': return 'text-blue-400';
      case 'BINANCE_API': return 'text-orange-400';
      case 'BINANCE_WS': return 'text-amber-500';
      default: return 'text-gray-400';
    }
  };

  // The filtering is now implicitly handled by the state `logs` which is
  // loaded based on the active tab.
  const displayedLogs = logs;

  const timestampFormatOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  };

  return (
    <div className="flex flex-col h-full">
      <h2 className="text-2xl font-bold text-white mb-4">Live Console</h2>
      <div className="bg-[#14181f]/50 border border-[#2b2f38] rounded-lg shadow-lg flex flex-col flex-grow">
          <div className="flex space-x-1 border-b border-[#2b2f38] px-2 overflow-x-auto">
              {TABS.map(tab => (
                  <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`px-4 py-2 text-sm font-medium border-b-2 capitalize transition-colors flex-shrink-0 ${
                          activeTab === tab
                              ? 'border-[#f0b90b] text-[#f0b90b]'
                              : 'border-transparent text-gray-400 hover:text-white'
                      }`}
                  >
                      {tab.toLowerCase().replace(/_/g, ' ')}
                  </button>
              ))}
          </div>
          <div 
              ref={logContainerRef}
              className="flex-grow p-4 overflow-y-auto font-spacemono text-sm"
              style={{ maxHeight: 'calc(100vh - 18rem)' }}
          >
              {displayedLogs.slice().reverse().map((log, index) => (
                  <div key={index} className="flex">
                      <span className="text-gray-500 mr-4 whitespace-nowrap">
                        {new Date(log.timestamp).toLocaleString(undefined, timestampFormatOptions)}
                      </span>
                      <span className={`${getLogLevelClass(log.level)} font-bold w-28 flex-shrink-0`}>
                          [{log.level}]
                      </span>
                      <span className="text-gray-300 flex-1 whitespace-pre-wrap break-words">{log.message}</span>
                  </div>
              ))}
          </div>
      </div>
    </div>
  );
};

export default ConsolePage;