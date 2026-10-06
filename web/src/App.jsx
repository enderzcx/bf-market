/*
Copyright (C) 2025 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

import React, { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Loading from './components/common/ui/Loading';
import { PrivateRoute, PublicOnlyRoute, RoleRoute } from './helpers/routes';

const GlobalHome = lazy(() => import('./pages/GlobalHome'));
const LoginForm = lazy(() => import('./components/auth/LoginForm'));
const GlobalConsole = lazy(() => import('./pages/GlobalConsole'));
const ConsoleOrders = lazy(() => import('./pages/GlobalConsole/Orders'));
const ConsoleSettlements = lazy(
  () => import('./pages/GlobalConsole/Settlements'),
);
const ConsoleWallet = lazy(() => import('./pages/GlobalConsole/Wallet'));
const ProgressLab = lazy(() => import('./pages/ProgressLab'));
const ProgressPage = lazy(() => import('./pages/Progress'));
const DocsPage = lazy(() => import('./pages/Docs'));
const MarketPage = lazy(() => import('./pages/Market'));
const RecordsPage = lazy(() => import('./pages/Records'));
const NotFound = lazy(() => import('./pages/NotFound'));

function App() {
  const location = useLocation();

  return (
    <Suspense fallback={<Loading />} key={location.pathname}>
      <Routes>
        <Route path='/' element={<GlobalHome />} />
        <Route
          path='/login'
          element={
            <PublicOnlyRoute>
              <LoginForm />
            </PublicOnlyRoute>
          }
        />
        <Route path='/progress-lab' element={<ProgressLab />} />
        <Route path='/progress' element={<ProgressPage />} />
        <Route path='/docs' element={<DocsPage />} />
        <Route path='/market' element={<MarketPage />} />
        <Route path='/records' element={<RecordsPage />} />
        <Route
          path='/console'
          element={
            <PrivateRoute>
              <GlobalConsole />
            </PrivateRoute>
          }
        />
        <Route
          path='/console/orders'
          element={
            <RoleRoute role='merchant'>
              <ConsoleOrders />
            </RoleRoute>
          }
        />
        <Route
          path='/console/settlements'
          element={
            <PrivateRoute>
              <ConsoleSettlements />
            </PrivateRoute>
          }
        />
        <Route
          path='/console/wallet'
          element={
            <RoleRoute role='promoter'>
              <ConsoleWallet />
            </RoleRoute>
          }
        />
        <Route path='/register' element={<Navigate to='/login' replace />} />
        <Route path='/reset' element={<Navigate to='/login' replace />} />
        <Route path='*' element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}

export default App;
