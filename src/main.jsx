import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { GazeSettingsProvider } from './context/GazeSettingsContext'
import { AACBoardProvider } from './context/AACBoardContext'
import { VocabularyProvider } from './context/VocabularyContext'
import { PhraseProvider } from './context/PhraseContext'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <GazeSettingsProvider>
        <AACBoardProvider>
          <VocabularyProvider>
            <PhraseProvider>
              <App />
            </PhraseProvider>
          </VocabularyProvider>
        </AACBoardProvider>
      </GazeSettingsProvider>
    </ErrorBoundary>
  </React.StrictMode>
)


