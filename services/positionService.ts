
import { Trade, OrderSide } from '../types';
import { priceStore } from './priceStore';
import { PriceUpdate } from './websocketService';

type PositionSubscriber = (positions: Trade[]) => void;

class PositionService {
    private activePositions: Trade[] = [];
    private subscribers = new Set<PositionSubscriber>();
    private isInitialized = false;
    private priceStoreUnsubscribe: (() => void) | null = null;

    // This method will be called by mockApi to set the initial state
    public _initialize(initialPositions: Trade[]): void {
        if (!this.isInitialized) {
            this.activePositions = initialPositions;
            this.isInitialized = true;

            // Start listening to price updates. Ensure we don't subscribe multiple times.
            if (!this.priceStoreUnsubscribe) {
                 this.priceStoreUnsubscribe = priceStore.subscribe(this.handlePriceUpdate);
            }
        }
    }

    private handlePriceUpdate = (update: PriceUpdate) => {
        let hasChanges = false;
        this.activePositions = this.activePositions.map(pos => {
            if (pos.symbol === update.symbol) {
                const newPrice = update.price;
                const oldPrice = pos.current_price || pos.entry_price;

                const priceDirection = newPrice > oldPrice ? 'up' : (newPrice < oldPrice ? 'down' : pos.priceDirection || 'neutral');
                const pnl = (newPrice - pos.entry_price) * pos.quantity * (pos.side === OrderSide.BUY ? 1 : -1);
                const entryValue = pos.entry_price * pos.quantity;
                const pnl_pct = entryValue !== 0 ? (pnl / entryValue) * 100 : 0;
                
                hasChanges = true;
                return {
                    ...pos,
                    current_price: newPrice,
                    pnl,
                    pnl_pct,
                    priceDirection,
                };
            }
            return pos;
        });

        if (hasChanges) {
            this.notify();
        }
    };

    public subscribe(callback: PositionSubscriber): () => void {
        this.subscribers.add(callback);
        // Immediately provide the current list to the new subscriber
        callback([...this.activePositions]);
        // Return an unsubscribe function
        return () => this.unsubscribe(callback);
    }

    public unsubscribe(callback: PositionSubscriber): void {
        this.subscribers.delete(callback);
    }

    private notify(): void {
        // Notify all subscribers with a new copy of the array
        this.subscribers.forEach(callback => callback([...this.activePositions]));
    }

    public getPositions(): Trade[] {
        return [...this.activePositions];
    }

    public addPosition(trade: Trade): void {
        this.activePositions.push(trade);
        this.notify();
    }

    public removePosition(tradeId: number): Trade | undefined {
        const tradeIndex = this.activePositions.findIndex(t => t.id === tradeId);
        if (tradeIndex > -1) {
            const [removedTrade] = this.activePositions.splice(tradeIndex, 1);
            this.notify();
            return removedTrade;
        }
        return undefined;
    }
    
    public setPositions(positions: Trade[]): void {
        this.activePositions = positions;
        this.notify();
    }

    public updatePosition(tradeId: number, updates: Partial<Trade>): void {
        const tradeIndex = this.activePositions.findIndex(t => t.id === tradeId);
        if (tradeIndex > -1) {
            // Update the trade object with the new values
            this.activePositions[tradeIndex] = { ...this.activePositions[tradeIndex], ...updates };
            this.notify();
        }
    }

    public clearPositions(): void {
        this.activePositions = [];
        this.notify();
    }
}

export const positionService = new PositionService();