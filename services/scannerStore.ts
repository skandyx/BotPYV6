import { ScannedPair, BotSettings } from '../types';
import { logService } from './logService';

type ScannerStoreSubscriber = (pairs: ScannedPair[]) => void;

class ScannerStore {
    private pairs = new Map<string, ScannedPair>();
    private subscribers = new Set<ScannerStoreSubscriber>();
    private isInitialized = false; // Kept for potential future use, but not critical now
    private settings: BotSettings | null = null; // Kept for context, but calculations are backend-side

    // --- Observable Store Methods ---
    public subscribe(callback: ScannerStoreSubscriber): () => void {
        this.subscribers.add(callback);
        // Immediately provide the current list to the new subscriber
        callback(this.getScannedPairs());
        return () => this.unsubscribe(callback);
    }

    public unsubscribe(callback: ScannerStoreSubscriber): void {
        this.subscribers.delete(callback);
    }

    private notify(): void {
        const pairsArray = this.getScannedPairs();
        this.subscribers.forEach(callback => callback(pairsArray));
    }

    // --- Core Logic (Simplified for Frontend) ---
    public initialize(): void {
        if (this.isInitialized) return;
        logService.log('INFO', '[ScannerStore] Initializing...');
        this.isInitialized = true;
    }

    public updateSettings(newSettings: BotSettings): void {
        // The frontend store no longer performs calculations, but it's good practice
        // to be aware of the settings if needed for display logic in the future.
        logService.log('INFO', '[ScannerStore] Settings reference updated.');
        this.settings = newSettings;
    }
    
    public updatePairList(newPairs: ScannedPair[]): void {
        logService.log('INFO', `[ScannerStore] Updating scanner list with ${newPairs.length} pairs from initial poll.`);
        
        const newPairsMap = new Map(newPairs.map(p => [p.symbol, p]));

        // Replace the entire list with the new polled data.
        // Real-time updates will overwrite this data via WebSockets.
        this.pairs = newPairsMap;
        
        this.notify();
    }

    public handlePriceUpdate(update: { symbol: string, price: number }): void {
        const pair = this.pairs.get(update.symbol);
        if (pair) {
            const oldPrice = pair.price;
            pair.price = update.price;
            pair.priceDirection = update.price > oldPrice ? 'up' : (update.price < oldPrice ? 'down' : pair.priceDirection || 'neutral');
            this.notify();
        }
    }

    /**
     * Handles a full scanner pair object update from the WebSocket.
     * This is the new primary way real-time data (indicators, score) enters the store.
     */
    public handleScannerUpdate(updatedPair: ScannedPair): void {
        const existingPair = this.pairs.get(updatedPair.symbol);
        if (existingPair) {
            // Merge the new data, preserving the price direction from the more frequent price updates
            const priceDirection = existingPair.priceDirection;
            Object.assign(existingPair, updatedPair);
            existingPair.priceDirection = priceDirection;
        } else {
            // This pair might be new since the last poll
            this.pairs.set(updatedPair.symbol, updatedPair);
        }
        this.notify();
    }
    
    public getScannedPairs(): ScannedPair[] {
        return Array.from(this.pairs.values());
    }
}

export const scannerStore = new ScannerStore();