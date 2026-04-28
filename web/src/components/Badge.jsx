import React from 'react';

export default function Badge({ type, text }) {
  return <span className={`badge ${type}`}>{text}</span>;
}
