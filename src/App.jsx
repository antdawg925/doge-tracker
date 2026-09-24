import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from './components/AppLayout';
import Home from './pages/Home';
import Research from './pages/Research';
import Scanner from './pages/Scanner';
import ShortKings from './pages/ShortKings';
import Alerts from './pages/Alerts';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Home />} />
          <Route path="/home" element={<Home />} />
          <Route path="/research" element={<Research />} />
          <Route path="/scanner" element={<Scanner />} />
          <Route path="/short-kings" element={<ShortKings />} />
          <Route path="/alerts" element={<Alerts />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
