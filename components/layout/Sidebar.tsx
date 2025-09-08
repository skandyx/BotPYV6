

import React from 'react';
import { NavLink } from 'react-router-dom';
import { useSidebar } from '../../contexts/SidebarContext';
import { DashboardIcon, ScannerIcon, HistoryIcon, SettingsIcon, ConsoleIcon, SidebarToggleIcon, ResearchIcon } from '../icons/Icons';

interface NavItemProps {
  to: string;
  isCollapsed: boolean;
  children: React.ReactNode;
}

const NavItem: React.FC<NavItemProps> = ({ to, isCollapsed, children }) => {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => {
        const baseClasses = 'group flex items-center px-4 py-3 text-sm font-semibold rounded-lg transition-colors';
        if (isCollapsed) {
          return `${baseClasses} justify-center ${isActive ? 'text-[#f0b90b]' : 'text-gray-300 hover:text-white hover:bg-[#14181f]/50'}`;
        } else {
          return `${baseClasses} ${isActive ? 'bg-[#14181f] text-white' : 'text-gray-300 hover:text-white hover:bg-[#14181f]/50'}`;
        }
      }}
    >
      {children}
    </NavLink>
  );
};

const Sidebar: React.FC = () => {
  const { isCollapsed, toggleSidebar, isMobileOpen } = useSidebar();

  const navItemTextClass = `whitespace-nowrap overflow-hidden transition-all duration-300 ease-in-out ${isCollapsed ? 'w-0 ml-0' : 'w-auto ml-3'}`;
  const logoPyClass = `whitespace-nowrap overflow-hidden transition-all duration-300 ease-in-out ${isCollapsed ? 'w-0' : 'w-auto'}`;

  const sidebarClasses = `
    bg-[#0c0e12] border-r border-[#1a1d26] flex flex-col
    transition-transform md:transition-all duration-300 ease-in-out
    md:relative md:translate-x-0
    fixed inset-y-0 left-0 z-50
    ${isMobileOpen ? 'translate-x-0' : '-translate-x-full'}
    ${isCollapsed ? 'md:w-20' : 'md:w-64'}
    w-64
  `;

  return (
    <div className={sidebarClasses}>
      <div className="h-16 flex items-center justify-center px-4 border-b border-[#1a1d26] flex-shrink-0">
        <h1 className="text-2xl font-bold text-white tracking-wider flex items-center">
          <span className="text-[#f0b90b]">{isCollapsed ? 'B' : 'BOT'}</span>
          <span className={`text-gray-400 ${logoPyClass}`}>{isCollapsed ? '' : 'PY'}</span>
        </h1>
      </div>
      <nav className="flex-1 px-4 py-6 space-y-2">
        <NavItem to="/dashboard" isCollapsed={isCollapsed}>
          <DashboardIcon />
          <span className={navItemTextClass}>Tableau de Bord</span>
        </NavItem>
        <NavItem to="/scanner" isCollapsed={isCollapsed}>
          <ScannerIcon />
          <span className={navItemTextClass}>Scanner</span>
        </NavItem>
        <NavItem to="/research" isCollapsed={isCollapsed}>
          <ResearchIcon />
          <span className={navItemTextClass}>Recherche</span>
        </NavItem>
        <NavItem to="/history" isCollapsed={isCollapsed}>
          <HistoryIcon />
          <span className={navItemTextClass}>Historique</span>
        </NavItem>
        <NavItem to="/settings" isCollapsed={isCollapsed}>
          <SettingsIcon />
          <span className={navItemTextClass}>Paramètres</span>
        </NavItem>
        <NavItem to="/console" isCollapsed={isCollapsed}>
          <ConsoleIcon />
          <span className={navItemTextClass}>Console</span>
        </NavItem>
      </nav>
      <div className="p-4 border-t border-[#1a1d26] hidden md:block">
         <button 
            onClick={toggleSidebar}
            className="w-full group flex items-center justify-center p-2 rounded-lg hover:bg-[#14181f]/50 transition-colors"
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
         >
            <SidebarToggleIcon isCollapsed={isCollapsed} />
         </button>
       </div>
    </div>
  );
};

export default Sidebar;