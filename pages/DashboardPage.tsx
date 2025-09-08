import React, { useState, useEffect, useMemo } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { api } from '../services/mockApi';
import { BotStatus, Trade, PerformanceStats, OrderSide, TradingMode, BotSettings, OrderStatus, ScannedPair } from '../types';
import StatCard from '../components/common/StatCard';
import Spinner from '../components/common/Spinner';
import Modal from '../components/common/Modal';
import { useAppContext } from '../contexts/AppContext';
import { useBotState } from '../contexts/BotStateContext';
import { positionService } from '../services/positionService';
import TradingViewWidget from '../components/common/TradingViewWidget';

const formatPrice = (price: number | undefined | null): string => {
    if (price === undefined || price === null) return 'N/A';
    if (price >= 1000) return price.toFixed(2);
    if (price >= 10) return price.toFixed(3);
    if (price >= 0.1) return price.toFixed(4);
    if (price >= 0.001) return price.toFixed(6);
    return price.toFixed(8);
};

const getScoreBadgeClass = (score: ScannedPair['score'] | undefined) => {
    if (!score) return 'bg-gray-700 text-gray-200';
    switch (score) {
        case 'STRONG BUY': return 'bg-green-600 text-green-100';
        case 'MOMENTUM_BUY': return 'bg-orange-500 text-orange-100';
        case 'BUY': return 'bg-green-800 text-green-200';
        case 'HOLD': return 'bg-gray-700 text-gray-200';
        case 'COOLDOWN': return 'bg-blue-800 text-blue-200';
        default: return 'bg-gray-700 text-gray-200';
    }
};

const ActivePositionsTable: React.FC<{ positions: Trade[], onManualClose: (trade: Trade) => void, onSymbolClick: (symbol: string) => void }> = ({ positions, onManualClose, onSymbolClick }) => {
    const getSideClass = (side: OrderSide) => side === OrderSide.BUY ? 'text-green-400' : 'text-red-400';
    const getPnlClass = (pnl: number = 0) => {
        if (pnl > 0) return 'text-green-400';
        if (pnl < 0) return 'text-red-400';
        return 'text-gray-300';
    };

    if (positions.length === 0) {
        return <p className="text-center text-gray-500 py-8">Aucune position active.</p>;
    }

    return (
        <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-[#2b2f38]">
                <thead className="bg-[#14181f]">
                    <tr>
                        {['Symbole', 'Côté', 'Prix d\'Entrée', 'Prix Actuel', 'Quantité', 'Stop Loss', 'Take Profit', 'PnL ($)', 'PnL %', 'Score Entrée', 'Tendance 4h (EMA50)', 'RSI 1h Entrée'].map(header => (
                            <th key={header} scope="col" className="px-3 lg:px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">{header}</th>
                        ))}
                        <th scope="col" className="relative px-3 lg:px-6 py-3">
                           <span className="sr-only">Fermer</span>
                        </th>
                    </tr>
                </thead>
                <tbody className="bg-[#14181f]/50 divide-y divide-[#2b2f38]">
                    {positions.map(pos => {
                        const priceClass = pos.priceDirection === 'up' ? 'text-green-400' : (pos.priceDirection === 'down' ? 'text-red-400' : 'text-gray-300');
                        const snapshot = pos.entry_snapshot;
                        return (
                            <tr 
                                key={pos.id}
                                onClick={() => onSymbolClick(pos.symbol)}
                                className="hover:bg-[#2b2f38]/50 cursor-pointer transition-colors"
                            >
                                <td className="px-3 lg:px-6 py-4 whitespace-nowrap text-sm font-medium text-white">
                                    <div className="flex items-center">
                                        <span>{pos.symbol}</span>
                                        {pos.is_scaling_in && (
                                            <span className="ml-2 text-xs font-semibold bg-sky-700 text-sky-200 px-2 py-0.5 rounded-full animate-pulse">
                                                Scaling In...
                                            </span>
                                        )}
                                    </div>
                                </td>
                                <td className={`px-3 lg:px-6 py-4 whitespace-nowrap text-sm font-bold ${getSideClass(pos.side)}`}>{pos.side}</td>
                                <td className="px-3 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-300">${formatPrice(pos.average_entry_price)}</td>
                                <td className={`px-3 lg:px-6 py-4 whitespace-nowrap text-sm font-mono transition-colors duration-200 ${priceClass}`}>${formatPrice(pos.current_price || pos.entry_price)}</td>
                                <td className="px-3 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-300">{pos.quantity.toFixed(4)}</td>
                                <td className="px-3 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-300">${formatPrice(pos.stop_loss)}</td>
                                <td className="px-3 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-300">${formatPrice(pos.take_profit)}</td>
                                <td className={`px-3 lg:px-6 py-4 whitespace-nowrap text-sm font-medium ${getPnlClass(pos.pnl)}`}>${pos.pnl?.toFixed(2) || '0.00'}</td>
                                <td className={`px-3 lg:px-6 py-4 whitespace-nowrap text-sm font-medium ${getPnlClass(pos.pnl_pct)}`}>{pos.pnl_pct?.toFixed(2) || 'N/A'}%</td>
                                <td className="px-3 lg:px-6 py-4 whitespace-nowrap text-sm">
                                    <span className={`px-2.5 py-1 text-xs font-semibold rounded-full ${getScoreBadgeClass(snapshot?.score)}`}>
                                        {snapshot?.score || 'N/A'}
                                    </span>
                                </td>
                                <td className="px-3 lg:px-6 py-4 whitespace-nowrap text-sm font-semibold">
                                     {snapshot?.price_above_ema50_4h === true ? <span className="text-green-400">▲ HAUSSIER</span> : (snapshot?.price_above_ema50_4h === false ? <span className="text-red-400">▼ BAISSIER</span> : <span className="text-gray-500">-</span>)}
                                </td>
                                <td className="px-3 lg:px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-300">{snapshot?.rsi_1h?.toFixed(1) || 'N/A'}</td>
                                <td className="px-3 lg:px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onManualClose(pos);
                                        }}
                                        className="text-red-500 hover:text-red-700 transition-colors"
                                        title="Fermer la position manuellement"
                                    >
                                        <svg className="h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                        </svg>
                                    </button>
                                </td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        </div>
    );
};


const DashboardPage: React.FC = () => {
    const [status, setStatus] = useState<BotStatus | null>(null);
    const [positions, setPositions] = useState<Trade[]>([]);
    const [stats, setStats] = useState<PerformanceStats | null>(null);
    const [settings, setSettings] = useState<BotSettings | null>(null);
    const [tradeHistory, setTradeHistory] = useState<Trade[]>([]);
    const [loading, setLoading] = useState(true);
    const [isCloseModalOpen, setIsCloseModalOpen] = useState(false);
    const [tradeToClose, setTradeToClose] = useState<Trade | null>(null);
    const { tradeActivityCounter, fearAndGreed } = useAppContext();
    const { tradingMode } = useBotState();
    const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);

    const openCloseModal = (trade: Trade) => {
        setTradeToClose(trade);
        setIsCloseModalOpen(true);
    };

    const handleManualClose = async () => {
        if (!tradeToClose) return;
        try {
            // The API call triggers a WebSocket message from the backend,
            // which causes AppContext to refresh all position data automatically.
            await api.closeTrade(tradeToClose.id);
        } catch (error) {
            console.error("Failed to manually close trade:", error);
        } finally {
            setIsCloseModalOpen(false);
            setTradeToClose(null);
        }
    };

    // Effect to subscribe to the central position store for reactive updates.
    useEffect(() => {
        const unsubscribe = positionService.subscribe(setPositions);
        return unsubscribe;
    }, []);


    // Effect for the initial load of aggregate data
    useEffect(() => {
        let isMounted = true;
        const loadInitialData = async () => {
            setLoading(true);
            try {
                const [statusData, statsData, settingsData, historyData] = await Promise.all([
                    api.fetchBotStatus(),
                    api.fetchPerformanceStats(),
                    api.fetchSettings(),
                    api.fetchTradeHistory(),
                ]);
                
                if (isMounted) {
                    setStatus(statusData);
                    setStats(statsData);
                    setSettings(settingsData);
                    setTradeHistory(historyData);
                }
            } catch (error) {
                console.error("Failed to fetch dashboard data:", error);
            } finally {
                if (isMounted) setLoading(false);
            }
        };

        loadInitialData();
        return () => { isMounted = false; };
    }, [tradingMode]);

    // Effect to refresh aggregate stats when a trade occurs, without a loading spinner
    useEffect(() => {
        if (tradeActivityCounter === 0) return; // Skip initial render

        let isMounted = true;
        const refreshStats = async () => {
            try {
                 const [statusData, statsData, historyData] = await Promise.all([
                     api.fetchBotStatus(),
                     api.fetchPerformanceStats(),
                     api.fetchTradeHistory(),
                 ]);
                 if(isMounted) {
                    setStatus(statusData);
                    setStats(statsData);
                    setTradeHistory(historyData);
                 }
            } catch (error) {
                console.error("Failed to refresh stats:", error);
            }
        };

        refreshStats();
        return () => { isMounted = false; };
    }, [tradeActivityCounter]);
    
    const performanceChartData = useMemo(() => {
        if (!tradeHistory || tradeHistory.length === 0) {
            return [{ name: 'Début', pnl: 0 }];
        }
    
        const sortedTrades = [...tradeHistory]
            .filter(t => t.status === OrderStatus.CLOSED && t.exit_time)
            .sort((a, b) => new Date(a.exit_time!).getTime() - new Date(b.exit_time!).getTime());

        let cumulativePnl = 0;
        const data = sortedTrades.map((trade, index) => {
            cumulativePnl += trade.pnl || 0;
            return {
                name: `T${index + 1}`,
                pnl: cumulativePnl,
            };
        });
        
        return [{ name: 'Début', pnl: 0 }, ...data];
    }, [tradeHistory]);


    if (loading) {
        return <div className="flex justify-center items-center h-64"><Spinner /></div>;
    }

    if (!status || !stats || !settings) {
        return <p className="text-center text-red-500">Échec du chargement des données du tableau de bord.</p>;
    }
    
    const getModeLabel = (mode: TradingMode) => {
        switch (mode) {
            case TradingMode.VIRTUAL: return 'Virtuel';
            case TradingMode.REAL_PAPER: return 'Réel (Papier)';
            case TradingMode.REAL_LIVE: return 'Réel (Live)';
        }
    };
    
    const getSentimentColor = (value: number) => {
        if (value < 25) return 'text-red-400';
        if (value < 45) return 'text-orange-400';
        if (value < 55) return 'text-yellow-400';
        if (value < 75) return 'text-green-400';
        return 'text-emerald-400';
    };

    const totalPnlClass = stats.total_pnl > 0 ? 'text-green-400' : stats.total_pnl < 0 ? 'text-red-400' : 'text-gray-100';

    return (
        <>
        <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6">
                <StatCard title="Solde" value={`$${status.balance.toFixed(2)}`} subtitle={getModeLabel(status.mode)} />
                <StatCard title="Positions Ouvertes" value={status.positions} subtitle={`Max: ${status.max_open_positions}`} />
                <StatCard title="PnL Total" value={`$${stats.total_pnl.toFixed(2)}`} subtitle={`Taux de Victoire: ${stats.win_rate.toFixed(1)}%`} valueClassName={totalPnlClass} />
                <StatCard title="Paires Suivies" value={status.monitored_pairs} subtitle={`Volume > $${(settings.MIN_VOLUME_USD / 1000000).toFixed(0)}M`} />
                <StatCard 
                    title="Fear & Greed Index" 
                    value={fearAndGreed?.value ?? '...'} 
                    subtitle={fearAndGreed?.classification ?? 'Chargement...'} 
                    valueClassName={fearAndGreed ? getSentimentColor(fearAndGreed.value) : ''} 
                />
            </div>

            {selectedSymbol && (
                <div className="bg-[#14181f]/50 border border-[#2b2f38] rounded-lg p-3 sm:p-5 shadow-lg relative">
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="text-lg font-semibold text-white">Graphique : {selectedSymbol}</h3>
                        <button 
                            onClick={() => setSelectedSymbol(null)} 
                            className="text-gray-400 hover:text-white text-2xl leading-none absolute top-3 right-4 z-10"
                            aria-label="Fermer le graphique"
                        >
                           &times;
                        </button>
                    </div>
                    <TradingViewWidget symbol={selectedSymbol} />
                </div>
            )}

            <div className="bg-[#14181f]/50 border border-[#2b2f38] rounded-lg p-3 sm:p-5 shadow-lg">
                <h3 className="text-lg font-semibold text-white mb-4">Performance</h3>
                    <ResponsiveContainer width="100%" height={250}>
                    <AreaChart data={performanceChartData} margin={{ top: 10, right: 20, left: -20, bottom: 0 }}>
                        <defs>
                            <linearGradient id="colorPnl" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#16a34a" stopOpacity={0.8}/>
                            <stop offset="95%" stopColor="#16a34a" stopOpacity={0}/>
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#2b2f38" />
                        <XAxis dataKey="name" stroke="#A0AEC0" />
                        <YAxis stroke="#A0AEC0" />
                        <Tooltip contentStyle={{ backgroundColor: '#14181f', border: '1px solid #2b2f38' }} />
                        <Area type="monotone" dataKey="pnl" stroke="#16a34a" fillOpacity={1} fill="url(#colorPnl)" />
                    </AreaChart>
                </ResponsiveContainer>
            </div>

            <div className="bg-[#14181f]/50 border border-[#2b2f38] rounded-lg p-3 sm:p-5 shadow-lg">
                <h3 className="text-lg font-semibold text-white mb-4">Positions Actives</h3>
                <ActivePositionsTable positions={positions} onManualClose={openCloseModal} onSymbolClick={setSelectedSymbol} />
            </div>
            
            <div className="bg-[#14181f]/50 border border-[#2b2f38] rounded-lg p-3 sm:p-5 shadow-lg">
                 <h3 className="text-lg font-semibold text-white mb-4">Top Paires Suivies</h3>
                 <div className="flex flex-wrap gap-2">
                     {status.top_pairs.map(pair => (
                         <button
                            key={pair}
                            onClick={() => setSelectedSymbol(pair)}
                            className="bg-gray-700 text-yellow-300 text-xs font-medium px-2.5 py-1 rounded-full hover:bg-gray-600 transition-colors"
                         >
                            {pair}
                         </button>
                     ))}
                 </div>
            </div>
        </div>
        <Modal
            isOpen={isCloseModalOpen}
            onClose={() => setIsCloseModalOpen(false)}
            onConfirm={handleManualClose}
            title={`Fermer la position pour ${tradeToClose?.symbol} ?`}
            confirmText="Oui, Fermer la Position"
            confirmVariant="danger"
        >
            Vous êtes sur le point de fermer manuellement la position pour {tradeToClose?.quantity} {tradeToClose?.symbol}.
            Cette action est irréversible.
        </Modal>
        </>
    );
};

export default DashboardPage;