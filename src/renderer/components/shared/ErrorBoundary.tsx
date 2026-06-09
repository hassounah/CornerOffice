import React from 'react'
import { PanelError } from './PanelError'

interface Props {
  children: React.ReactNode
  fallback?: React.ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: React.ErrorInfo | null
}

/**
 * React error boundary — catches render errors in the component subtree and
 * shows PanelError (or a custom fallback) instead of crashing the whole UI.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null, errorInfo: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ errorInfo: info })
    console.error(
      '[ErrorBoundary] Caught render error:\n',
      'Error:', error.message, '\n',
      'Stack:', error.stack, '\n',
      'Component stack:', info.componentStack,
    )
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null })
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      return (
        <PanelError
          onRetry={this.handleRetry}
          error={this.state.error}
          componentStack={this.state.errorInfo?.componentStack}
        />
      )
    }
    return this.props.children
  }
}
