

import React, { useState, useEffect, useMemo } from 'react';
import { ScannedPair, StrategyConditions, BotSettings, StrategyType } from '../types';
import Spinner from '../components/common/Spinner';
import { scannerStore } from '../services/scannerStore';
import { useAppContext } from '../contexts/AppContext';
import TradingViewWidget from '../components/common/TradingViewWidget';
import { SearchIcon } from '../components/icons/Icons';
import Tooltip from '../components/common/Tooltip';


type SortableKeys = keyof ScannedPair;
type SortDirection = 'asc' | 'desc';

interface SortConfig {
  key: SortableKeys;
  direction: SortDirection;
}

const formatPrice = (price: number | undefined | null): string => {
    if (price === undefined || price === null) return 'N/A';
    if (price >= 1000) return price.toFixed(2);
    if (price >= 10) return price.toFixed(3);
    if (price >= 0.1) return price.toFixed(4);
    if (price >= 0.001) return price.toFixed(6);
    return price.toFixed(8);
};

const formatVolume = (volume: number | undefined | null): string => {
    if (volume === undefined || volume === null) return 'N/A';
    if (volume >= 1_000_000) return `${(volume / 1_000_000).toFixed(2)}M`;
    if (volume >= 1_000) return `${(volume / 1_000).toFixed(1)}k`;
    return volume.toFixed(0);
};

const getStrategyDisplayInfo = (strategy?: StrategyType): { icon: string; title: string } => {
    switch (strategy) {
        case 'PRECISION':
            return { icon: '🎯', title: 'Signal de Précision (Squeeze)' };
        case 'MOMENTUM':
            return { icon: '🔥', title: 'Signal de Momentum détecté' };
        case 'IGNITION':
            return { icon: '🚀', title: 'Signal d\'Ignition (Pump) détecté' };
        default:
            return { icon: '', title: '' };
    }
};

const SortableHeader: React.FC<{
    sortConfig: SortConfig | null;
    requestSort: (key: SortableKeys) => void;
    sortKey: SortableKeys;
    children: React.ReactNode;
    className?: string;
}> = ({ sortConfig, requestSort, sortKey, children, className }) => {
    const isSorted = sortConfig?.key === sortKey;
    const directionIcon = isSorted ? (sortConfig?.direction === 'asc' ? '▲' : '▼') : '';
    const baseClasses = "px-2 sm:px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-[#14181f] transition-colors";

    return (
        <th 
            scope="col" 
            className={`${baseClasses} ${className || ''}`}
            onClick={() => requestSort(sortKey)}
        >
            <div className="flex items-center">
                <span>{children}</span>
                <span className="ml-2 text-[#f0b90b]">{directionIcon}</span>
            </div>
        </th>
    );
};

const EmptyScannerIcon = () => (
    <svg className="mx-auto h-12 w-12 text-gray-500" fill="none" viewBox="0 0 24 24" strokeWidth="1" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.042 21.672L13.684 16.6m0 0l-2.51 2.225.569-9.47 5.227 7.917-3.286-.672zm-7.518-.267A8.25 8.25 0 1120.25 10.5M8.288 14.212A5.25 5.25 0 1117.25 10.5" />
    </svg>
);

const Dot: React.FC<{ active: boolean; tooltip: string }> = ({ active, tooltip }) => (
    <div
      className={`h-3 w-3 rounded-full transition-colors ${active ? 'bg-green-500' : 'bg-red-500'}`}
      title={tooltip}
    />
);

const ConditionDots: React.FC<{ conditions?: StrategyConditions }> = ({ conditions }) => {
    const conditionTooltips = {
        squeeze: 'Précision: Compression 15m (BB Squeeze)',
        breakout: 'Précision: Cassure 1m (Clôture > EMA9)',
        volume: 'Précision: Volume 1m (> 1.5x Moyenne)',
        obv: 'Précision: Confirmation OBV 1m',
        cvd_5m_trending_up: 'Précision: Confirmation CVD 5m',
        safety: 'Sécurité Partagée: RSI 1h < Seuil',
        rsi_mtf: 'Sécurité Partagée: RSI 15m < Seuil',
        structure: 'Précision: Confirmation Structurelle 15m',
        momentum_impulse: 'Momentum: Bougie d\'impulsion 15m',
        momentum_confirmation: 'Momentum: Suivi 5m',
    };

    return (
        <div className="flex items-center space-x-2">
            <Dot active={conditions?.squeeze ?? false} tooltip={conditionTooltips.squeeze} />
            <Dot active={conditions?.breakout ?? false} tooltip={conditionTooltips.breakout} />
            <Dot active={conditions?.volume ?? false} tooltip={conditionTooltips.volume} />
            <Dot active={conditions?.obv ?? false} tooltip={conditionTooltips.obv} />
            <Dot active={conditions?.cvd_5m_trending_up ?? false} tooltip={conditionTooltips.cvd_5m_trending_up} />
            <Dot active={conditions?.safety ?? false} tooltip={conditionTooltips.safety} />
            <Dot active={conditions?.rsi_mtf ?? false} tooltip={conditionTooltips.rsi_mtf} />
            <Dot active={conditions?.structure ?? false} tooltip={conditionTooltips.structure} />
            <Dot active={conditions?.momentum_impulse ?? false} tooltip={conditionTooltips.momentum_impulse} />
        </div>
    );
};


const ScannerPage: React.FC = () => {
  const [pairs, setPairs] = useState<ScannedPair[]>(() => scannerStore.getScannedPairs());
  const [sortConfig, setSortConfig] = useState<SortConfig | null>({ key: 'score_value', direction: 'desc' });
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const { settings } = useAppContext();

  // Robust check to ensure all required settings for rendering are fully loaded.
  // This prevents crashes from race conditions on page refresh.
  const settingsReady = useMemo(() => {
    if (!settings) return false;
    return (
      typeof settings.RSI_OVERBOUGHT_THRESHOLD === 'number' &&
      typeof settings.RSI_15M_OVERBOUGHT_THRESHOLD === 'number' &&
      typeof settings.ADX_THRESHOLD_RANGE === 'number' &&
      typeof settings.ATR_PCT_THRESHOLD_VOLATILE === 'number'
    );
  }, [settings]);


  useEffect(() => {
    const handleStoreUpdate = (updatedPairs: ScannedPair[]) => {
      setPairs(updatedPairs);
    };

    const unsubscribe = scannerStore.subscribe(handleStoreUpdate);
    setPairs(scannerStore.getScannedPairs());

    return () => {
      unsubscribe();
    };
  }, []);

  const requestSort = (key: SortableKeys) => {
    let direction: SortDirection = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const filteredAndSortedPairs = useMemo(() => {
    const filtered = searchQuery
        ? pairs.filter(p => p.symbol.toLowerCase().includes(searchQuery.toLowerCase()))
        : pairs;

    let sortablePairs = [...filtered];
    if (sortConfig !== null) {
      sortablePairs.sort((a, b) => {
        let aVal, bVal;
        const key = sortConfig.key;
        
        // --- Custom sort logic for nested/derived properties ---
        if (key === 'bollinger_bands_15m') {
            aVal = a.bollinger_bands_15m?.width_pct;
            bVal = b.bollinger_bands_15m?.width_pct;
        } else {
            aVal = a[key as keyof ScannedPair];
            bVal = b[key as keyof ScannedPair];
        }
        
        if (aVal === undefined || aVal === null) return 1;
        if (bVal === undefined || bVal === null) return -1;
        
        if (aVal < bVal) {
          return sortConfig.direction === 'asc' ? -1 : 1;
        }
        if (aVal > bVal) {
          return sortConfig.direction === 'asc' ? 1 : -1;
        }
        return 0;
      });
    }
    return sortablePairs;
  }, [pairs, sortConfig, searchQuery]);
  
    const getScoreDisplay = (pair: ScannedPair): { className: string; text: string } => {
        switch (pair.score) {
            case 'STRONG BUY':
                return { className: 'bg-green-600 text-green-100', text: 'STRONG BUY' };
            case 'MOMENTUM_BUY':
                return { className: 'bg-orange-500 text-orange-100', text: 'MOMENTUM' };
            case 'BUY':
                return { className: 'bg-sky-600 text-sky-100', text: 'BUY' };
            case 'COMPRESSION':
                return { className: 'bg-yellow-600 text-yellow-100', text: 'COMPRESSION' };
            case 'PENDING_CONFIRMATION':
                return { className: 'bg-sky-600 text-sky-100 animate-pulse', text: 'ATTENTE 5m' };
            case 'FAKE_BREAKOUT':
                return { className: 'bg-red-800 text-red-200', text: 'FAKE BREAKOUT' };
            case 'COOLDOWN':
                return { className: 'bg-blue-800 text-blue-200', text: 'COOLDOWN' };
            case 'HOLD':
            default:
                return { className: 'bg-gray-700 text-gray-200', text: 'HOLD' };
        }
    };

  
  // --- COLOR CODING HELPERS ---
  const getTrendColorClass = (isAbove?: boolean): string => {
    if (isAbove === true) return 'text-green-400';
    if (isAbove === false) return 'text-red-400';
    return 'text-gray-500';
  };

  const getTrendScoreColorClass = (score?: number): string => {
    if (score === undefined || score === null) return 'text-gray-500';
    if (score > 75) return 'text-green-400';
    if (score > 50) return 'text-yellow-400';
    return 'text-red-400';
  };

  const getRsiColorClass = (rsi: number | undefined, which: '1h' | '15m'): string => {
    if (rsi === undefined || !settings) return 'text-gray-500';

    const threshold = which === '1h' 
        ? settings.RSI_OVERBOUGHT_THRESHOLD 
        : settings.RSI_15M_OVERBOUGHT_THRESHOLD;

    if (threshold === undefined) return 'text-gray-500';

    if (rsi >= threshold) return 'text-red-400 font-bold';
    if (rsi >= threshold - 10) return 'text-yellow-400';
    return 'text-green-400';
  };

  const getBbWidthColorClass = (bbWidth?: number, isInSqueeze?: boolean): string => {
      if (isInSqueeze) return 'text-sky-300 font-semibold';
      if (bbWidth === undefined || bbWidth === null) return 'text-gray-500';
      if (bbWidth < 2.0) return 'text-yellow-400';
      return 'text-gray-300';
  };

  const getAdxColorClass = (adx?: number): string => {
    if (adx === undefined || !settings?.ADX_THRESHOLD_RANGE) return 'text-gray-500';
    if (adx < settings.ADX_THRESHOLD_RANGE) return 'text-sky-400';
    if (adx > 40) return 'text-green-400 font-bold';
    return 'text-gray-300';
  };

  const getAtrPctColorClass = (atrPct?: number): string => {
      if (atrPct === undefined || !settings?.ATR_PCT_THRESHOLD_VOLATILE) return 'text-gray-500';
      if (atrPct > settings.ATR_PCT_THRESHOLD_VOLATILE) return 'text-red-400 font-bold';
      return 'text-gray-300';
  };


  if (!settingsReady) {
    return <div className="flex justify-center items-center h-64"><Spinner /></div>;
  }
  
  const totalColumnCount = 14;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl sm:text-3xl font-bold text-white">Scanner de Marché</h2>

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
          <TradingViewWidget
            symbol={selectedSymbol}
          />
        </div>
      )}


      <div className="bg-[#14181f]/50 border border-[#2b2f38] rounded-lg shadow-lg overflow-hidden">
         <div className="p-4 bg-[#14181f]/30">
            <div className="relative w-full md:max-w-xs">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <SearchIcon />
                </div>
                <input
                    type="text"
                    placeholder="Rechercher Symbole..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="block w-full rounded-md border-[#3e4451] bg-[#0c0e12]/50 pl-10 pr-4 py-2 shadow-sm focus:border-[#f0b90b] focus:ring-[#f0b90b] sm:text-sm text-white"
                />
            </div>
        </div>
        <div className="overflow-x-auto overflow-y-auto" style={{ maxHeight: 'calc(100vh - 20rem)' }}>
            <table className="min-w-full divide-y divide-[#2b2f38]">
                <thead className="bg-[#14181f] sticky top-0 z-10">
                    <tr>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="strategy_type" className="text-center">Signal</SortableHeader>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="symbol">Symbole</SortableHeader>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="price">Prix</SortableHeader>
                        <th scope="col" className="px-2 sm:px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">Tendance 4h</th>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="score_value">Score Global</SortableHeader>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="trend_score">Score Tendance</SortableHeader>
                        <th scope="col" className="px-2 sm:px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                            <div className="flex items-center">
                                <span>Conditions</span>
                                <Tooltip text="Conditions pour la stratégie Précision (Squeeze) et Momentum. La Tendance 4h est dans sa propre colonne." />
                            </div>
                        </th>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="rsi_1h">RSI 1h</SortableHeader>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="rsi_15m">RSI 15m</SortableHeader>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="volume">Volume 24h</SortableHeader>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="adx_15m">ADX 15m</SortableHeader>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="atr_pct_15m">ATR % 15m</SortableHeader>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="bollinger_bands_15m">Largeur BB 15m</SortableHeader>
                        <SortableHeader sortConfig={sortConfig} requestSort={requestSort} sortKey="atr_15m">ATR 15m</SortableHeader>
                    </tr>
                </thead>
                <tbody className="bg-[#14181f]/50 divide-y divide-[#2b2f38]">
                    {filteredAndSortedPairs.length > 0 ? (
                        filteredAndSortedPairs.map(pair => {
                            const priceClass = pair.priceDirection === 'up' ? 'text-green-400' : (pair.priceDirection === 'down' ? 'text-red-400' : 'text-gray-300');
                            const bbWidth = pair.bollinger_bands_15m?.width_pct;
                            const scoreDisplay = getScoreDisplay(pair);
                            const rowClass = pair.score === 'PENDING_CONFIRMATION' ? 'bg-sky-900/40' : '';
                            const trendClass = getTrendColorClass(pair.price_above_ema50_4h);

                            const { met, total } = (() => {
                                if (!settings || !pair.conditions) return { met: pair.conditions_met_count || 0, total: 8 };
                                // This logic is now handled entirely by the backend to simplify the frontend.
                                // We just display what the backend provides.
                                return { met: pair.conditions_met_count || 0, total: 8 };
                            })();

                            const { icon: strategyIcon, title: strategyTitle } = getStrategyDisplayInfo(pair.strategy_type);


                            return (
                                <tr 
                                    key={pair.symbol}
                                    onClick={() => setSelectedSymbol(pair.symbol)}
                                    className={`hover:bg-[#2b2f38]/50 cursor-pointer transition-colors ${rowClass}`}
                                >
                                    <td className="px-2 sm:px-4 lg:px-6 py-4 whitespace-nowrap text-center text-xl">
                                        <span title={strategyTitle}>
                                            {strategyIcon}
                                        </span>
                                    </td>
                                    <td className="px-2 sm:px-4 lg:px-6 py-4 whitespace-nowrap text-sm font-medium text-white">{pair.symbol}</td>
                                    <td className={`px-2 sm:px-4 lg:px-6 py-4 whitespace-nowrap text-sm font-mono transition-colors duration-200 ${priceClass}`}>${formatPrice(pair.price)}</td>
                                    <td className={`px-2 sm:px-4 lg:px-6 py-4 whitespace-nowrap text-sm font-semibold ${trendClass}`}>
                                        {pair.price_above_ema50_4h === true ? '▲ HAUSSIER' : (pair.price_above_ema50_4h === false ? '▼ BAISSIER' : 'N/A')}
                                    </td>
                                    <td className="px-2 sm:px-4 lg:px-6 py-4 whitespace-nowrap text-sm">
                                        <div className="flex items-center w-[180px]">
                                            <span className={`px-2.5 py-1 text-xs font-semibold rounded-l-full ${scoreDisplay.className} w-28 text-center flex-shrink-0`}>
                                                {scoreDisplay.text}
                                            </span>
                                            {total > 0 ? (
                                                <div className="bg-gray-600 rounded-r-full h-6 flex-grow relative flex items-center" title={`${met} sur ${total} conditions remplies`}>
                                                    <div 
                                                        className="bg-green-500 h-full rounded-r-full transition-all duration-300" 
                                                        style={{ width: `${(met / total) * 100}%` }}
                                                    ></div>
                                                    <span className="absolute inset-0 text-white text-xs font-bold flex items-center justify-center mix-blend-difference">
                                                        {met}/{total}
                                                    </span>
                                                </div>
                                            ) : (
                                                <div className="bg-gray-600 rounded-r-full h-6 flex-grow flex items-center justify-center">
                                                    <span className="text-gray-400 text-xs">-/-</span>
                                                </div>
                                            )}
                                        </div>
                                    </td>
                                    <td className={`px-2 sm:px-4 lg:px-6 py-4 whitespace-nowrap text-sm font-bold ${getTrendScoreColorClass(pair.trend_score)}`}>
                                        {pair.trend_score?.toFixed(0) || 'N/A'}
                                    </td>
                                    <td className="px-2 sm:px-4 lg:px-6 py-4 whitespace-nowrap">
                                        <ConditionDots conditions={pair.conditions} />
                                    </td>
                                    <td className={`px-2 sm:px-4 lg:px-6 py-4 whitespace-nowrap text-sm ${getRsiColorClass(pair.rsi_1h, '1h')}`}>
                                        {pair.rsi_1h?.toFixed(1) || 'N/A'}
                                    </td>
                                    <td className={`px-2 sm:px-4 lg:px-6 py-4 whitespace-nowrap text-sm ${getRsiColorClass(pair.rsi_15m, '15m')}`}>
                                        {pair.rsi_15m?.toFixed(1) || 'N/A'}
                                    </td>
                                    <td className="px-2 sm:px-4 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                                        {typeof pair.volume === 'number' ? `$${(pair.volume / 1_000_000).toFixed(2)}M` : 'N/A'}
                                    </td>
                                     <td className={`px-2 sm:px-4 lg:px-6 py-4 whitespace-nowrap text-sm ${getAdxColorClass(pair.adx_15m)}`} title="Force de la Tendance ( < 20 = Range, > 40 = Fort)">
                                        {pair.adx_15m?.toFixed(1) || 'N/A'}
                                    </td>
                                    <td className={`px-2 sm:px-4 lg:px-6 py-4 whitespace-nowrap text-sm ${getAtrPctColorClass(pair.atr_pct_15m)}`} title="Volatilité en % du Prix">
                                        {pair.atr_pct_15m?.toFixed(2) || 'N/A'}%
                                    </td>
                                    <td className="px-2 sm:px-4 lg:px-6 py-4 whitespace-nowrap text-sm">
                                        <div className="flex items-center space-x-2">
                                            <span className={getBbWidthColorClass(bbWidth, pair.is_in_squeeze_15m)}>
                                                {bbWidth !== undefined ? `${bbWidth.toFixed(2)}%` : 'N/A'}
                                            </span>
                                            {pair.is_in_squeeze_15m && (
                                                <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-sky-800 text-sky-200" title="Bollinger Bands Squeeze Detected">
                                                    SQUEEZE
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-2 sm:px-4 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-400 font-mono">
                                        {formatPrice(pair.atr_15m)}
                                    </td>
                                </tr>
                            )
                        })
                    ) : (
                         <tr>
                            <td colSpan={totalColumnCount} className="px-6 py-16 text-center text-gray-500">
                                <div className="flex flex-col items-center">
                                    <EmptyScannerIcon />
                                    <h3 className="mt-4 text-sm font-semibold text-gray-300">
                                        {searchQuery ? 'Aucun Résultat' : 'Aucune Paire Trouvée'}
                                    </h3>
                                    <p className="mt-1 text-sm text-gray-500">
                                        {searchQuery 
                                            ? `Aucune paire ne correspond à "${searchQuery}".`
                                            : "Aucune paire ne correspond actuellement aux critères du scanner."
                                        }
                                    </p>
                                     {!searchQuery && (
                                        <p className="mt-1 text-sm text-gray-500">
                                            Essayez d'ajuster vos filtres sur la page Paramètres ou attendez que les conditions du marché changent.
                                        </p>
                                     )}
                                </div>
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

export default ScannerPage;