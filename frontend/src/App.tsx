import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { OverviewPage } from './pages/OverviewPage';
import { JobsPage } from './pages/JobsPage';
import { JobDetailPage } from './pages/JobDetailPage';
import { PhdPage } from './pages/PhdPage';
import { PhdDetailPage } from './pages/PhdDetailPage';
import { ProfilesPage } from './pages/ProfilesPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { ApplicationsPage } from './pages/ApplicationsPage';
import { ApplicationReviewPage } from './pages/ApplicationReviewPage';
import { ApplicationQueuePage } from './pages/ApplicationQueuePage';
import { AssistantMonitorPage } from './pages/AssistantMonitorPage';
import { SettingsPage } from './pages/SettingsPage';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="jobs/:id" element={<JobDetailPage />} />
        <Route path="phd" element={<PhdPage />} />
        <Route path="phd/:id" element={<PhdDetailPage />} />
        <Route path="profiles" element={<ProfilesPage />} />
        <Route path="documents" element={<DocumentsPage />} />
        <Route path="queue" element={<ApplicationQueuePage />} />
        <Route path="assistant" element={<AssistantMonitorPage />} />
        <Route path="assistant/:id" element={<AssistantMonitorPage />} />
        <Route path="applications" element={<ApplicationsPage />} />
        <Route path="applications/:id" element={<ApplicationReviewPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
