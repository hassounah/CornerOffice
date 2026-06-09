import React, { Suspense } from 'react'
import { Outlet } from 'react-router'
import { OrgSidebar } from './OrgSidebar'
import { TopBar } from './TopBar'
import { WindowTitleBar } from './WindowTitleBar'
import { ShipMomentOverlay } from '../gamification/ShipMoment'

export function AppShell(): React.ReactElement {
  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-co-bg-primary">
      {/* Custom frameless title bar — spans full width */}
      <WindowTitleBar />

      {/* App body — sidebar + main content */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:rounded-md focus:bg-co-accent focus:text-white focus:text-sm focus:font-medium"
        >
          Skip to content
        </a>

        {/* Left sidebar — glass overlay */}
        <OrgSidebar />

        {/* Main content column */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          <TopBar />

          {/* Page content with atmospheric background */}
          <main
            className="flex-1 overflow-y-auto co-atmosphere"
            id="main-content"
            tabIndex={-1}
          >
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <div className="h-5 w-5 rounded-full border-2 border-co-accent border-t-transparent animate-spin motion-reduce:animate-none" />
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </main>
        </div>

        <ShipMomentOverlay />
      </div>
    </div>
  )
}
