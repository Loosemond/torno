import { hint, pressed } from '../../shared/keys'
import { useEffect, useRef, useState } from 'react'
import type { BuildError } from '../../shared/build'

/** Everything the kernel said about a failed build, as one text to paste elsewhere. */
export function errorText(error: BuildError): string {
  return [error.message, error.traceback, error.output]
    .map((part) => part?.trimEnd())
    .filter(Boolean)
    .join('\n\n')
}

/**
 * The failed build in full: message, traceback and what the model printed. It
 * rises from the status line over the viewport; the parts of the last good
 * build stay visible above it.
 */
export function BuildErrorSheet({ objectName, error, onClose }: { objectName: string; error: BuildError; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const body = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (pressed(e, 'sheet.close')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  async function copy() {
    try {
      await navigator.clipboard.writeText(errorText(error))
    } catch {
      // No clipboard access (the window is not focused): copy the text as shown.
      const selection = getSelection()
      selection?.selectAllChildren(body.current!)
      document.execCommand('copy')
      selection?.removeAllRanges()
    }
    setCopied(true)
  }

  return (
    <section className="sheet" role="dialog" aria-label="Build error">
      <header className="sheet-head">
        <h2 className="sheet-title">{objectName} did not build</h2>
        <span className="num muted">{error.kind}</span>
        <span className="spacer" />
        <button type="button" className="button" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="icon-button" aria-label="Close" title={`Close (${hint('sheet.close')})`} onClick={onClose}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" aria-hidden="true">
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <div className="sheet-body" ref={body}>
        <p className="sheet-message">{error.message}</p>
        {error.traceback?.trim() && (
          <>
            <h3 className="section-title">Traceback</h3>
            <pre className="sheet-pre" data-part="traceback">{error.traceback.trimEnd()}</pre>
          </>
        )}
        {error.output?.trim() && (
          <>
            <h3 className="section-title">Output</h3>
            <pre className="sheet-pre" data-part="output">{error.output.trimEnd()}</pre>
          </>
        )}
      </div>
    </section>
  )
}
