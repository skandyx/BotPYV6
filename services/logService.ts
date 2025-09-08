import { LogEntry, LOG_LEVELS, LogTab } from '../types';

type LogSubscriber = (log: LogEntry) => void;

class LogService {
    private allLogs: LogEntry[] = [];
    private logsByLevel: Map<LogEntry['level'], LogEntry[]> = new Map();
    private subscribers: LogSubscriber[] = [];
    private readonly MAX_LOGS = 500;

    constructor() {
        LOG_LEVELS.forEach(level => {
            this.logsByLevel.set(level, []);
        });
        this.log('INFO', 'Log service initialized with multi-buffer support.');
    }

    public log(level: LogEntry['level'], message: string) {
        const newLog: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            message,
        };

        // Add to allLogs (chronological) buffer
        this.allLogs.push(newLog);
        if (this.allLogs.length > this.MAX_LOGS) {
            this.allLogs.shift();
        }

        // Add to specific level buffer
        const levelBuffer = this.logsByLevel.get(level);
        if (levelBuffer) {
            levelBuffer.push(newLog);
            if (levelBuffer.length > this.MAX_LOGS) {
                levelBuffer.shift();
            }
        }
        
        this.subscribers.forEach(cb => cb(newLog));
    }

    public subscribe(callback: LogSubscriber) {
        if (!this.subscribers.includes(callback)) {
            this.subscribers.push(callback);
        }
    }
    
    public unsubscribe(callback: LogSubscriber) {
        this.subscribers = this.subscribers.filter(cb => cb !== callback);
    }

    public getLogs(tab: LogTab = 'ALL'): LogEntry[] {
        if (tab === 'ALL') {
            return [...this.allLogs];
        }
        const levelBuffer = this.logsByLevel.get(tab as LogEntry['level']);
        return levelBuffer ? [...levelBuffer] : [];
    }
}

export const logService = new LogService();