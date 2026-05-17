import { useVocabulary, PAGE_META } from '@context/VocabularyContext'
import './NavBreadcrumb.css'

/**
 * NavBreadcrumb — Milestone 4
 *
 * Displays the current vocabulary page context in the title bar.
 * When at root: shows "🏠 Home"
 * When on a sub-page: shows "🏠 › 🍽 Eat"
 *
 * The 🏠 home segment is mouse-clickable so caregivers can return
 * to the root grid without relying on the gaze HOME cell.
 * (Gaze users activate the HOME cell on the sub-page itself.)
 */
export function NavBreadcrumb() {
  const { activePage, goHome } = useVocabulary()

  const homeMeta  = PAGE_META.home
  const pageMeta  = PAGE_META[activePage]
  const isSubPage = activePage !== 'home'

  return (
    <nav className="nav-breadcrumb" aria-label="Vocabulary navigation">
      <button
        className={[
          'nav-breadcrumb__segment',
          'nav-breadcrumb__segment--home',
          !isSubPage ? 'nav-breadcrumb__segment--active' : ''
        ].join(' ').trim()}
        aria-label="Return to home vocabulary"
        onClick={isSubPage ? goHome : undefined}
        aria-current={!isSubPage ? 'page' : undefined}
      >
        <span aria-hidden="true">{homeMeta.icon}</span>
        <span className="nav-breadcrumb__label">{homeMeta.label}</span>
      </button>

      {isSubPage && (
        <>
          <span className="nav-breadcrumb__separator" aria-hidden="true">›</span>
          <span
            className="nav-breadcrumb__segment nav-breadcrumb__segment--active"
            aria-current="page"
          >
            <span aria-hidden="true">{pageMeta?.icon}</span>
            <span className="nav-breadcrumb__label">{pageMeta?.label}</span>
          </span>
        </>
      )}
    </nav>
  )
}
