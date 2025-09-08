
import React from 'react';

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  children?: React.ReactNode;
  valueClassName?: string;
}

const StatCard: React.FC<StatCardProps> = ({ title, value, subtitle, children, valueClassName }) => {
  return (
    <div className="bg-[#14181f]/50 border border-[#2b2f38] rounded-lg p-5 shadow-lg flex flex-col justify-between">
      <div>
        <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-gray-400 uppercase tracking-wider">{title}</p>
            {children}
        </div>
        <p className={`text-2xl md:text-3xl font-bold text-gray-100 mt-2 ${valueClassName || ''}`}>
          {value}
        </p>
      </div>
      {subtitle && <p className="text-xs text-gray-500 mt-1">{subtitle}</p>}
    </div>
  );
};

export default StatCard;