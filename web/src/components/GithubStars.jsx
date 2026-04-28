import React, { useState, useEffect } from 'react';

export default function GithubStars() {
  const [stars, setStars] = useState(null);
  useEffect(() => {
    fetch('https://api.github.com/repos/iadityaharsh/postgresql-cluster')
      .then(r => r.json())
      .then(d => { if (d.stargazers_count !== undefined) setStars(d.stargazers_count); })
      .catch(() => {});
  }, []);
  if (stars === null) return null;
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: 'var(--warn)', fontSize: 11, marginLeft: 2 }}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25z"/></svg>
      {stars}
    </span>
  );
}
