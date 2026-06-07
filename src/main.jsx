import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { GazeSettingsProvider } from './context/GazeSettingsContext'
import { CameraVisionProvider } from './context/CameraVisionContext'
import { AACBoardProvider } from './context/AACBoardContext'
import { VocabularyProvider } from './context/VocabularyContext'
import { PhraseProvider } from './context/PhraseContext'
import { GazeHeatmapProvider } from './context/GazeHeatmapContext'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <GazeSettingsProvider>
        <CameraVisionProvider>
          <AACBoardProvider>
            <VocabularyProvider>
              <PhraseProvider>
                <GazeHeatmapProvider>
                  <App />
                </GazeHeatmapProvider>
              </PhraseProvider>
            </VocabularyProvider>
          </AACBoardProvider>
        </CameraVisionProvider>
      </GazeSettingsProvider>
    </ErrorBoundary>
  </React.StrictMode>
)


