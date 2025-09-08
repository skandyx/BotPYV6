import React, { useEffect, useRef, memo } from 'react';

// Make TradingView available on the window object
declare global {
  interface Window {
    TradingView: any;
  }
}

interface TradingViewWidgetProps {
  symbol: string;
  defaultInterval?: string;
}

const TradingViewWidget: React.FC<TradingViewWidgetProps> = ({ symbol, defaultInterval = "15" }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<any>(null); // Ref to store the widget instance
  const containerId = 'tradingview_widget_container';

  useEffect(() => {
    const createWidget = () => {
      if (!containerRef.current || !window.TradingView || !window.TradingView.widget) {
        console.error("TradingView script not loaded or container not ready.");
        return;
      }
      
      // Clean up previous widget instance if it exists
      if (widgetRef.current) {
        try {
          widgetRef.current.remove();
        } catch (error) {
          console.warn("Could not remove previous TradingView widget:", error);
        }
        widgetRef.current = null;
      }
      containerRef.current.innerHTML = ''; // Ensure container is empty as a fallback

      const widget = new window.TradingView.widget({
        autosize: true,
        symbol: `BINANCE:${symbol}`,
        interval: defaultInterval,
        timezone: "Etc/UTC",
        theme: "dark",
        style: "1",
        locale: "fr",
        toolbar_bg: "#f1f3f6",
        enable_publishing: false,
        hide_side_toolbar: false,
        allow_symbol_change: true,
        container_id: containerId,
        details: true,
        hotlist: true,
        calendar: true,
      });
      widgetRef.current = widget;
    };

    if (window.TradingView && window.TradingView.widget) {
      createWidget();
    } else {
      const script = document.querySelector('script[src="https://s3.tradingview.com/tv.js"]');
      if (script) {
        script.addEventListener('load', createWidget, { once: true });
      } else {
        console.error("TradingView script tag not found in the document.");
      }
    }

    return () => {
      if (widgetRef.current) {
        try {
          widgetRef.current.remove();
        } catch(error) {
            console.warn("Could not remove TradingView widget on cleanup:", error);
        }
        widgetRef.current = null;
      }
    };
  }, [symbol, defaultInterval]);

  return (
    <div 
      id={containerId} 
      ref={containerRef} 
      className="tradingview-widget-container h-[500px]"
    />
  );
};

export default memo(TradingViewWidget);
