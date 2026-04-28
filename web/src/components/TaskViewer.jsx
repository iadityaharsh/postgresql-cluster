import React, { useState, useEffect, useRef } from 'react';

export default function TaskViewer({ title, statusUrl, onClose, autoReload }) {
  const [log, setLog] = useState([]);
  const [running, setRunning] = useState(true);
  const [exitCode, setExitCode] = useState(null);
  const logRef = useRef(null);
  const lineCount = useRef(0);
  const sawSuccess = useRef(false);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (!active) return;
      try {
        const resp = await fetch(`${statusUrl}?since=${lineCount.current}`);
        const data = await resp.json();
        if (data.log && data.log.length > 0) {
          setLog(prev => [...prev, ...data.log]);
          lineCount.current = data.totalLines;
        }
        if (data.exitCode === 0) sawSuccess.current = true;
        setRunning(data.running);
        setExitCode(data.exitCode);
        if (data.running) setTimeout(poll, 500);
        else if (autoReload && data.exitCode === 0) {
          setTimeout(() => window.location.reload(), 2000);
        }
      } catch {
        if (sawSuccess.current && autoReload) {
          setTimeout(() => window.location.reload(), 3000);
          return;
        }
        if (active) setTimeout(poll, 1000);
      }
    };
    poll();
    return () => { active = false; };
  }, [statusUrl, autoReload]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const done = !running && exitCode !== null;
  const success = exitCode === 0;

  return (
    <div className="task-overlay" onClick={done ? onClose : undefined}>
      <div className="task-viewer" onClick={e => e.stopPropagation()}>
        <div className="task-viewer-header">
          <h3>
            {running && <span className="task-spinner" />}
            {!running && success && <span style={{ color: 'var(--ok)', fontSize: 16 }}>&#10003;</span>}
            {!running && !success && exitCode !== null && <span style={{ color: 'var(--err)', fontSize: 16 }}>&#10007;</span>}
            {title}
          </h3>
          <button className="task-viewer-close" onClick={onClose}>&times;</button>
        </div>
        <div className="task-viewer-log" ref={logRef}>
          {log.map((line, i) => {
            const isOk = line.includes('TASK OK');
            const isErr = line.includes('TASK ERROR') || line.includes('ERROR:');
            return <div key={i} className={`log-line ${isOk ? 'ok' : isErr ? 'err' : ''}`}>{line}</div>;
          })}
          {running && log.length === 0 && <div className="log-line">Waiting for output...</div>}
        </div>
        <div className="task-viewer-footer">
          <span style={{ color: running ? '#f0ad4e' : success ? '#50c878' : '#e74c3c' }}>
            {running ? 'Running...' : success ? 'Task completed successfully' : `Task failed (exit code ${exitCode})`}
          </span>
          <button className="btn" onClick={onClose}>{done ? 'Close' : 'Background'}</button>
        </div>
      </div>
    </div>
  );
}
