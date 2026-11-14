import { useNavigate } from 'react-router-dom'

export type BottomTab = 'tasks' | 'history' | 'sounds'

/**
 * The phone navigation at the bottom of the queue and the Sounds tab. The
 * queue passes onSelect to switch its own tabs in place; elsewhere the
 * buttons navigate.
 */
export function BottomNav({ active, onSelect }: { active: BottomTab; onSelect?: (tab: 'tasks' | 'history') => void }) {
  const navigate = useNavigate()
  const go = (tab: 'tasks' | 'history') => (onSelect ? onSelect(tab) : navigate(tab === 'history' ? '/?tab=history' : '/'))
  return (
    <nav className="bottom-nav" aria-label="Main Navigation">
      <div className="bottom-nav-inner">
        <button
          type="button"
          className={`bottom-nav-item ${active === 'tasks' ? 'active' : ''}`}
          onClick={() => go('tasks')}
        >
          <TasksIcon />
          <span>Tasks</span>
        </button>
        <button
          type="button"
          className={`bottom-nav-item ${active === 'history' ? 'active' : ''}`}
          onClick={() => go('history')}
        >
          <CheckCircleIcon />
          <span>Published</span>
        </button>
        <button
          type="button"
          className={`bottom-nav-item ${active === 'sounds' ? 'active' : ''}`}
          onClick={() => navigate('/sounds')}
        >
          <MusicIcon />
          <span>Sounds</span>
        </button>
      </div>
    </nav>
  )
}

function TasksIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  )
}

function CheckCircleIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  )
}

export function MusicIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  )
}
