import React, { createContext, useState, useContext, ReactNode, useEffect } from 'react';
import { api } from '../services/mockApi';
import { positionService } from '../services/positionService';

interface AuthContextType {
  isAuthenticated: boolean;
  login: (password: string) => Promise<boolean>;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    // On initial load, check with the backend if we have a valid session.
    const verifySession = async () => {
      try {
        const data = await api.checkSession();
        setIsAuthenticated(data.isAuthenticated);
        if (data.isAuthenticated) {
          const initialPositions = await api.fetchActivePositions();
          positionService._initialize(initialPositions);
        }
      } catch (error) {
        // If the server returns 401 Unauthorized, it's fine.
        console.log("No active session found.");
        setIsAuthenticated(false);
      } finally {
        setIsLoading(false);
      }
    };
    verifySession();
  }, []);

  const login = async (password: string): Promise<boolean> => {
    try {
      const response = await api.login(password);
      if (response.success) {
        setIsAuthenticated(true);
        const initialPositions = await api.fetchActivePositions();
        positionService._initialize(initialPositions);
        return true;
      }
      return false;
    } catch (error) {
      console.error("Login failed:", error);
      return false;
    }
  };

  const logout = async () => {
    try {
      await api.logout();
      positionService.clearPositions();
    } catch (error) {
      console.error("Logout failed:", error);
    } finally {
      setIsAuthenticated(false);
    }
  };

  return (
    <AuthContext.Provider value={{ isAuthenticated, login, logout, isLoading }}>
      {!isLoading && children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
