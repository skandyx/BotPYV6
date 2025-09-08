
import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { BotStateProvider } from './contexts/BotStateContext';
import { WebSocketProvider } from './contexts/WebSocketContext';
import { AppProvider } from './contexts/AppContext';
import { SidebarProvider } from './contexts/SidebarContext';
import Layout from './components/layout/Layout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import ScannerPage from './pages/ScannerPage';
import HistoryPage from './pages/HistoryPage';
import SettingsPage from './pages/SettingsPage';
import ConsolePage from './pages/ConsolePage';
import ResearchPage from './pages/ResearchPage';

const AppRoutes: React.FC = () => {
  const { isAuthenticated } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          isAuthenticated ? (
            <Layout>
              <Routes>
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/scanner" element={<ScannerPage />} />
                <Route path="/research" element={<ResearchPage />} />
                <Route path="/history" element={<HistoryPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/console" element={<ConsolePage />} />
                <Route path="*" element={<Navigate to="/dashboard" />} />
              </Routes>
            </Layout>
          ) : (
            <Navigate to="/login" />
          )
        }
      />
    </Routes>
  );
};


const App: React.FC = () => {
  return (
    <AuthProvider>
      <BotStateProvider>
        <WebSocketProvider>
          <AppProvider>
            <SidebarProvider>
              <AppRoutes />
            </SidebarProvider>
          </AppProvider>
        </WebSocketProvider>
      </BotStateProvider>
    </AuthProvider>
  );
};

export default App;