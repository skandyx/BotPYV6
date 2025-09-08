import React from 'react';
import { QuestionMarkCircleIcon } from '../icons/Icons';

interface TooltipProps {
  text: string;
}

const Tooltip: React.FC<TooltipProps> = ({ text }) => {
  return (
    <div className="group relative flex items-center">
      <QuestionMarkCircleIcon className="h-4 w-4 text-gray-500 cursor-help" />
      <div className="absolute bottom-full mb-2 w-64 rounded-lg bg-gray-900 border border-gray-700 p-3 text-xs text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none z-10 shadow-lg"
           style={{ transform: 'translateX(-50%)', left: '50%' }}>
        {text}
        <div className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 bg-gray-900 border-b border-r border-gray-700" style={{ transform: 'translateX(-50%) rotate(45deg)' }}></div>
      </div>
    </div>
  );
};

export default Tooltip;