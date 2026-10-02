/**
 * Dashboard rendering contract.
 *
 * Renders the monitoring page in jsdom and locks in the honesty rules of the
 * spec: every panel exists, unknown data shows "N/A"/"—" placeholders, the
 * empty states are the literal required strings, and no service that lacks a
 * status API is ever displayed as fake ONLINE.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import Dashboard from './Dashboard';

global.IS_REACT_ACT_ENVIRONMENT = true;

test('dashboard renders all panels with honest empty states', () => {
  render(<Dashboard />);
  expect(screen.getByText(/JARVIS DASHBOARD/)).toBeInTheDocument();
  expect(screen.getByText('SYSTEM PERFORMANCE')).toBeInTheDocument();
  expect(screen.getByText('JARVIS CORE STATUS')).toBeInTheDocument();
  expect(screen.getByText('NOW PLAYING')).toBeInTheDocument();
  expect(screen.getByText('No media playing')).toBeInTheDocument();
  expect(screen.getByText('RECENT ACTIVITY')).toBeInTheDocument();
  expect(screen.getByText('No recent activity')).toBeInTheDocument();
  expect(screen.getByText('SESSION STATISTICS')).toBeInTheDocument();
  expect(screen.getByText('COMMANDS')).toBeInTheDocument();
  // Services without a status API must show honest N/A, never fake ONLINE.
  expect(screen.getAllByText('⚪ N/A').length).toBeGreaterThanOrEqual(3);
  // Status pill starts at STARTING before the first poll settles.
  expect(screen.getByText('STARTING')).toBeInTheDocument();
  // Session counters show the em-dash placeholder, not fake numbers.
  expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
});
