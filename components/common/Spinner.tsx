
import React from 'react';

const Spinner: React.FC<{ size?: 'sm' | 'md' | 'lg' }> = ({ size = 'md' }) => {
    const sizeClasses = {
        sm: 'h-6 w-6',
        md: 'h-8 w-8',
        lg: 'h-12 w-12',
    };
    return (
        <div className={`animate-spin rounded-full border-4 border-gray-600 border-t-[#f0b90b] ${sizeClasses[size]}`}></div>
    );
};

export default Spinner;
