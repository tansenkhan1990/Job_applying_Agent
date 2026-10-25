import { NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { SettingsResponse } from '../api/types';
import { cn } from './ui';

const NAV = [
  { to: '/', label: 'Overview', icon: 'grid' },
  { to: '/jobs', label: 'Jobs', icon: 'briefcase' },
  { to: '/queue', label: 'Apply queue', icon: 'play' },
  { to: '/assistant', label: 'Assistant', icon: 'play' },
  { to: '/profiles', label: 'Profiles', icon: 'users' },
  { to: '/documents', label: 'Documents', icon: 'file' },
  { to: '/applications', label: 'Applications', icon: 'check' },
  { to: '/settings', label: 'Settings', icon: 'cog' },
] as const;

function Icon({ name }: { name: (typeof NAV)[number]['icon'] }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    viewBox: '0 0 24 24',
    className: 'h-4 w-4 flex-none',
    'aria-hidden': true,
  };
  switch (name) {
    case 'grid':
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
        </svg>
      );
    case 'briefcase':
      return (
        <svg {...common}>
          <rect x="3" y="7.5" width="18" height="12" rx="2" />
          <path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M3 12h18" />
        </svg>
      );
    case 'users':
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3.2" />
          <path d="M3.5 19.5c.6-3.1 2.8-4.8 5.5-4.8s4.9 1.7 5.5 4.8M16 5.2a3 3 0 0 1 0 5.8M17.5 14.9c1.8.5 3 2 3.3 4.1" />
        </svg>
      );
    case 'file':
      return (
        <svg {...common}>
          <path d="M6 3.5h7l5 5V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
          <path d="M13 3.5V9h5M8 13h7M8 16.5h5" />
        </svg>
      );
    case 'check':
      return (
        <svg {...common}>
          <path d="M8 3.5h8v3H8zM6 5.5H4.5v15h15v-15H18" />
          <path d="m8 13 2.5 2.5L16 10" />
        </svg>
      );
    case 'play':
      return (
        <svg {...common}>
          <path d="M8 5.2 19 12 8 18.8Z" />
        </svg>
      );
    case 'cog':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4 1.7 1.7 0 0 0-1.6 0Z" />
        </svg>
      );
  }
}

export function Layout() {
  const { data } = useQuery<SettingsResponse>({
    queryKey: ['settings'],
    queryFn: () => api<SettingsResponse>('/settings'),
    staleTime: 60_000,
    retry: 1,
  });

  const aiLabel = data
    ? data.ai.configured
      ? data.ai.model || 'Model not selected'
      : 'AI not configured'
    : 'Checking AI…';

  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden w-60 flex-none border-r border-slate-800/80 bg-slate-950/60 lg:flex lg:flex-col">
        <div className="flex items-center gap-3 border-b border-slate-800/80 px-5 py-5">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-indigo-500/15 text-lg ring-1 ring-indigo-500/30">
            <svg viewBox="0 0 24 24" className="h-5 w-5 text-indigo-300" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3.5 20 8v8l-8 4.5L4 16V8Z" />
              <path d="m8.5 12.2 2.4 2.4 4.8-5" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold text-white">Job Agent</p>
            <p className="text-[11px] text-slate-500">Local AI job search</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-indigo-500/15 text-indigo-200 ring-1 ring-indigo-500/25'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200',
                )
              }
            >
              <Icon name={item.icon} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-slate-800/80 px-4 py-4 text-[11px] leading-relaxed text-slate-500">
          <p className="flex items-center gap-1.5 text-slate-400">
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                data?.ai.configured ? 'bg-emerald-400' : 'bg-amber-400',
              )}
            />
            {aiLabel}
          </p>
          <p className="mt-2">
            Applications require explicit approval. Automated submission is not claimed for unsupported
            sites.
          </p>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur lg:hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-indigo-500/15 text-xs text-indigo-300 ring-1 ring-indigo-500/30">
                JA
              </span>
              <span className="text-sm font-semibold text-white">Job Agent</span>
            </div>
            <span
              className={cn(
                'flex items-center gap-1.5 text-[11px]',
                data?.ai.configured ? 'text-emerald-300' : 'text-amber-300',
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  data?.ai.configured ? 'bg-emerald-400' : 'bg-amber-400',
                )}
              />
              {data?.ai.configured ? 'AI ready' : 'Fallback mode'}
            </span>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-2 pb-2">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  cn(
                    'flex flex-none items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs',
                    isActive ? 'bg-indigo-500/15 text-indigo-200' : 'text-slate-400',
                  )
                }
              >
                <Icon name={item.icon} />
                {item.label}
              </NavLink>
            ))}
          </nav>
        </header>

        <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
