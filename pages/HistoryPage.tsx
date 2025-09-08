import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../services/mockApi';
import { Trade, OrderSide, TradingMode, ScannedPair, StrategyType } from '../types';
import Spinner from '../components/common/Spinner';
import StatCard from '../components/common/StatCard';
import { useAppContext } from '../contexts/AppContext';
import { SearchIcon, ExportIcon } from '../components/icons/Icons';
import TradingViewWidget from '../components/common/TradingViewWidget';


// --- TYPE DEFINITIONS ---
type SortableKeys = 'symbol' | 'entry_time' | 'exit_time' | 'pnl' | 'pnl_pct' | 'entry_price' | 'exit_price' | 'stop_loss' | 'take_profit' | 'strategy_type';
type SortDirection = 'asc' | 'desc';

interface SortConfig {
  key: SortableKeys;
  direction: SortDirection;
}

// --- HELPER FUNCTIONS ---
const formatPrice = (price: number | undefined | null): string => {
    if (price === undefined || price === null) return 'N/A';
    if (price >= 1000) return price.toFixed(2);
    if (price >= 10) return price.toFixed(3);
    if (price >= 0.1) return price.toFixed(4);
    if (price >= 0.001) return price.toFixed(6);
    return price.toFixed(8);
};

const dateTimeFormatOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
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

const getStrategyDisplayInfo = (strategy?: StrategyType): { icon: string; title: string } => {
    switch (strategy) {
        case 'PRECISION':
            return { icon: '🎯', title: 'Stratégie de Précision' };
        case 'MOMENTUM':
            return { icon: '🔥', title: 'Stratégie de Momentum' };
        case 'IGNITION':
            return { icon: '🚀', title: 'Stratégie d\'Ignition' };
        default:
            // Default for older trades that might not have a type
            return { icon: '🎯', title: 'Stratégie de Précision' };
    }
};

// --- SUB-COMPONENTS ---
const SortableHeader: React.FC<{
    sortConfig: SortConfig | null;
    requestSort: (key: SortableKeys) => void;
    sortKey: SortableKeys;
    children: React.ReactNode;
}> = ({ sortConfig, requestSort, sortKey, children }) => {
    const isSorted = sortConfig?.key === sortKey;
    const directionIcon = isSorted ? (sortConfig?.direction === 'asc' ? '▲' : '▼') : '';

    return (
        <th 
            scope="col" 
            className="px-3 lg:px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-[#14181f]/50 transition-colors"
            onClick={() => requestSort(sortKey)}
        >
            <div className="flex items-center">
                <span>{children}</span>
                <span className="ml-2 text-[#f0b90b]">{directionIcon}</span>
            </div>
        </th>
    );
};


// --- MAIN COMPONENT ---
const HistoryPage: React.FC = () => {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortConfig, setSortConfig] = useState<SortConfig | null>({ key: 'entry_time', direction: 'desc' });
  const [symbolFilter, setSymbolFilter] = useState('');
  const { tradeActivityCounter } = useAppContext();
  const [selectedTradeForChart, setSelectedTradeForChart] = useState<Trade | null>(null);

  useEffect(() => {
    const loadHistory = async () => {
      setLoading(true);
      try {
        const history = await api.fetchTradeHistory();
        setTrades(history);
      } catch (error) {
        console.error("Failed to fetch trade history:", error);
      } finally {
        setLoading(false);
      }
    };

    loadHistory();
  }, [tradeActivityCounter]);

  const { filteredAndSortedTrades, summaryStats } = useMemo(() => {
    let filteredTrades = trades;
    if (symbolFilter) {
      filteredTrades = trades.filter(trade => 
        trade.symbol.toLowerCase().includes(symbolFilter.toLowerCase())
      );
    }

    const sortedTrades = [...filteredTrades];
    if (sortConfig !== null) {
      sortedTrades.sort((a, b) => {
        const aValue = a[sortConfig.key];
        const bValue = b[sortConfig.key];
        
        if (aValue === undefined || aValue === null) return 1;
        if (bValue === undefined || bValue === null) return -1;
        
        if (aValue < bValue) {
          return sortConfig.direction === 'asc' ? -1 : 1;
        }
        if (aValue > bValue) {
          return sortConfig.direction === 'asc' ? 1 : -1;
        }
        return 0;
      });
    }

    const totalTrades = sortedTrades.length;
    const winningTrades = sortedTrades.filter(t => (t.pnl || 0) > 0).length;
    const losingTrades = sortedTrades.filter(t => (t.pnl || 0) < 0).length;
    const totalPnl = sortedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

    return { 
      filteredAndSortedTrades: sortedTrades, 
      summaryStats: { totalPnl, winningTrades, losingTrades, winRate } 
    };
  }, [trades, symbolFilter, sortConfig]);

  const requestSort = (key: SortableKeys) => {
    let direction: SortDirection = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };
  
  const handleExport = () => {
    if (filteredAndSortedTrades.length === 0) {
        alert("Aucune donnée à exporter.");
        return;
    }

    const headers = ['ID', 'Symbole', 'Stratégie', 'Côté', 'Mode', 'Heure d\'Entrée', 'Heure de Sortie', 'Prix d\'Entrée', 'Prix de Sortie', 'Stop Loss', 'Take Profit', 'Quantité', 'PnL ($)', 'PnL %', 'Score Entrée', 'Tendance 4h (EMA50)', 'RSI 1h Entrée'];
    
    const rows = filteredAndSortedTrades.map(trade => [
        trade.id,
        `"${trade.symbol}"`,
        trade.strategy_type || 'PRECISION',
        trade.side,
        trade.mode,
        `"${trade.entry_time}"`,
        `"${trade.exit_time || 'N/A'}"`,
        trade.entry_price,
        trade.exit_price || 'N/A',
        trade.stop_loss,
        trade.take_profit,
        trade.quantity,
        trade.pnl?.toFixed(4) || 'N/A',
        trade.pnl_pct?.toFixed(2) || 'N/A',
        trade.entry_snapshot?.score || 'N/A',
        trade.entry_snapshot?.price_above_ema50_4h ? 'HAUSSIER' : 'BAISSIER',
        trade.entry_snapshot?.rsi_1h?.toFixed(2) || 'N/A'
    ]);

    const csvContent = "data:text/csv;charset=utf-8," 
        + headers.join(",") + "\n" 
        + rows.map(e => e.join(",")).join("\n");

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `historique_trades_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  
  const getSideClass = (side: OrderSide) => side === OrderSide.BUY ? 'text-green-400' : 'text-red-400';
  const getPnlClass = (pnl: number = 0) => {
    if (pnl > 0) return 'text-green-400';
    if (pnl < 0) return 'text-red-400';
    return 'text-gray-300';
  };

  if (loading) {
    return <div className="flex justify-center items-center h-64"><Spinner /></div>;
  }

  const { totalPnl, winningTrades, losingTrades, winRate } = summaryStats;
  const totalColumns = 15;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-white">Historique des Transactions</h2>

       {selectedTradeForChart && (
        <div className="bg-[#14181f]/50 border border-[#2b2f38] rounded-lg p-3 sm:p-5 shadow-lg relative">
            <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-semibold text-white">
                    Analyse du Trade : {selectedTradeForChart.symbol} (ID: {selectedTradeForChart.id})
                </h3>
                <button 
                    onClick={() => setSelectedTradeForChart(null)} 
                    className="text-gray-400 hover:text-white text-2xl leading-none absolute top-3 right-4 z-10"
                    aria-label="Fermer le graphique"
                >
                   &times;
                </button>
            </div>
            <TradingViewWidget 
                symbol={selectedTradeForChart.symbol} 
                defaultInterval="1"
            />
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mt-4 text-sm">
                <div className="bg-[#0c0e12]/50 p-2 rounded-md">
                    <div className="text-gray-400 text-xs">Entrée</div>
                    <div className="font-semibold">${formatPrice(selectedTradeForChart.entry_price)}</div>
                </div>
                <div className="bg-[#0c0e12]/50 p-2 rounded-md">
                    <div className="text-gray-400 text-xs">Sortie</div>
                    <div className="font-semibold">${formatPrice(selectedTradeForChart.exit_price)}</div>
                </div>
                 <div className="bg-[#0c0e12]/50 p-2 rounded-md">
                    <div className="text-gray-400 text-xs">PnL ($)</div>
                    <div className={`font-semibold ${getPnlClass(selectedTradeForChart.pnl || 0)}`}>${selectedTradeForChart.pnl?.toFixed(2) ?? 'N/A'}</div>
                </div>
                 <div className="bg-[#0c0e12]/50 p-2 rounded-md">
                    <div className="text-gray-400 text-xs">PnL (%)</div>
                    <div className={`font-semibold ${getPnlClass(selectedTradeForChart.pnl_pct || 0)}`}>{selectedTradeForChart.pnl_pct?.toFixed(2) ?? 'N/A'}%</div>
                </div>
                 <div className="bg-[#0c0e12]/50 p-2 rounded-md">
                    <div className="text-gray-400 text-xs">Heure Entrée</div>
                    <div className="font-mono text-xs">{new Date(selectedTradeForChart.entry_time).toLocaleTimeString()}</div>
                </div>
                 <div className="bg-[#0c0e12]/50 p-2 rounded-md">
                    <div className="text-gray-400 text-xs">Heure Sortie</div>
                    <div className="font-mono text-xs">{selectedTradeForChart.exit_time ? new Date(selectedTradeForChart.exit_time).toLocaleTimeString() : 'N/A'}</div>
                </div>
            </div>
        </div>
      )}
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
         <StatCard title="P&L Total" value={`$${totalPnl.toFixed(2)}`} valueClassName={getPnlClass(totalPnl)} subtitle="Basé sur les filtres actuels" />
         <StatCard title="Trades (Gagnant/Perdant)" value={`${winningTrades} / ${losingTrades}`} subtitle="Basé sur les filtres actuels" />
         <StatCard title="Taux de Victoire" value={`${winRate.toFixed(1)}%`} subtitle="Basé sur les filtres actuels"/>
      </div>

      <div className="bg-[#14181f]/50 border border-[#2b2f38] rounded-lg shadow-lg overflow-hidden">
        <div className="p-4 flex flex-col md:flex-row justify-between items-center gap-4 bg-[#14181f]/30">
            <div className="relative w-full md:w-auto">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <SearchIcon />
                </div>
                <input
                    type="text"
                    placeholder="Filtrer par Symbole..."
                    value={symbolFilter}
                    onChange={(e) => setSymbolFilter(e.target.value)}
                    className="block w-full rounded-md border-[#3e4451] bg-[#0c0e12]/50 pl-10 pr-4 py-2 shadow-sm focus:border-[#f0b90b] focus:ring-[#f0b90b] sm:text-sm text-white"
                />
            </div>
            <button
                onClick={handleExport}
                className="inline-flex items-center justify-center rounded-md border border-transparent bg-[#f0b90b] px-4 py-2 text-sm font-medium text-black font-semibold shadow-sm hover:bg-yellow-500 focus:outline-none focus:ring-2 focus:ring-[#f0b90b] focus:ring-offset-2 focus:ring-offset-[#14181f] w-full md:w-auto"
            >
                <ExportIcon />
                <span className="ml-2">Exporter en CSV</span>
            </button>
        </div>
        <div className="overflow-x-auto overflow-y-auto" style={{ maxHeight: 'calc(100vh - 24rem)' }}>
            <table className="min-w-full divide-y divide-[#2b2f38]">
                <thead className="bg-[#14181f] sticky top-0">
                    <tr>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="symbol">Symbole</SortableHeader>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="strategy_type">Stratégie</SortableHeader>
                        <th scope="col" className="px-3 lg:px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">Côté</th>
                        <th scope="col" className="px-3 lg:px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">Score Entrée</th>
                        <th scope="col" className="px-3 lg:px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">Tendance 4h (EMA50)</th>
                        <th scope="col" className="px-3 lg:px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">RSI 1h Entrée</th>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="entry_time">Heure d'Entrée</SortableHeader>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="exit_time">Heure de Sortie</SortableHeader>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="entry_price">Prix d'Entrée</SortableHeader>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="exit_price">Prix de Sortie</SortableHeader>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="stop_loss">Stop Loss</SortableHeader>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="take_profit">Take Profit</SortableHeader>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="pnl">PnL ($)</SortableHeader>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="pnl_pct">PnL %</SortableHeader>
                    </tr>
                </thead>
                <tbody className="bg-[#14181f]/50 divide-y divide-[#2b2f38]">
                    {filteredAndSortedTrades.map(trade => {
                        const { icon: strategyIcon, title: strategyTitle } = getStrategyDisplayInfo(trade.strategy_type);
                        return (
                            <tr 
                                key={trade.id}
                                onClick={() => setSelectedTradeForChart(trade)}
                                className="hover:bg-[#2b2f38]/50 cursor-pointer transition-colors"
                            >
                                <td className="px-3 lg:px-6 py-4 whitespace-nowrap text-sm font-medium text-white">{trade.symbol}</td>
                                <td className="px-3 lg:px-6 py-4 whitespace-nowrap text-sm text-center">
                                    <span className="text-xl" title={strategyTitle}>
                                        {strategyIcon}
                                    </span>
                                </td>
                                <td className={`px-3 lg:px-6 py-4 whitespace-nowrap text-sm font-bold ${getSideClass(trade.side)}`}>{trade.side}</td>
                                <td className="px-3 lg:px-6 py-4 whitespace-nowrap text-sm">
                                    <span className={`px-2.5 py-1 text-xs font-semibold rounded-full ${getScoreBadgeClass(trade.entry_snapshot?.score)}`}>
                                        {trade.entry_snapshot?.score || 'N/A'}
                                    </span>
                                </td>
                                <td className="px-3 lg:px-6 py-4 whitespace-nowrap text-sm font-semibold">
                                    {trade.entry_snapshot?.price_above_ema50_4h === true ? <span className="text-green-400">▲ HAUSSIER</span> : (trade.entry_snapshot?.price_above_ema50_4h === false ? <span className="text-red-400">▼ BAISSIER</span> : <span className="text-gray-500">-</span>)}
                                </td>
                                <td className="px-3 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-300">{trade.entry_snapshot?.rsi_1h?.toFixed(1) || 'N/A'}</td>
                                <td className="px-3 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-400">{new Date(trade.entry_time).toLocaleString(undefined, dateTimeFormatOptions)}</td>
                                <td className="px-3 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-400">{trade.exit_time ? new Date(trade.exit_time).toLocaleString(undefined, dateTimeFormatOptions) : 'N/A'}</td>
                                <td className="px-3 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-300">${formatPrice(trade.entry_price)}</td>
                                <td className="px-3 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-300">${formatPrice(trade.exit_price)}</td>
                                <td className="px-3 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-300">${formatPrice(trade.stop_loss)}</td>
                                <td className="px-3 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-300">${formatPrice(trade.take_profit)}</td>
                                <td className={`px-3 lg:px-6 py-4 whitespace-nowrap text-sm font-medium ${getPnlClass(trade.pnl)}`}>${trade.pnl?.toFixed(2) || 'N/A'}</td>
                                <td className={`px-3 lg:px-6 py-4 whitespace-nowrap text-sm font-medium ${getPnlClass(trade.pnl_pct)}`}>${trade.pnl_pct?.toFixed(2) || 'N/A'}%</td>
                            </tr>
                        );
                    })}
                     {filteredAndSortedTrades.length === 0 && (
                        <tr>
                            <td colSpan={totalColumns} className="text-center py-10 text-gray-500">
                                Aucun trade trouvé pour le filtre actuel.
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
      </div>
    </div>
  );
};

export default HistoryPage;