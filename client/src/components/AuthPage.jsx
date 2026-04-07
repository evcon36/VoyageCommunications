import { useState } from 'react';
import LoginForm from './LoginForm';
import RegisterForm from './RegisterForm';

export default function AuthPage({ onLoginSuccess, authError }) {
  const [mode, setMode] = useState('login');

  return (
    <div className="auth-page">
      {authError && <p className="auth-error">{authError}</p>}

      {mode === 'login' ? (
        <LoginForm
          onLoginSuccess={onLoginSuccess}
          onSwitchToRegister={() => setMode('register')}
        />
      ) : (
        <RegisterForm
          onSwitchToLogin={() => setMode('login')}
        />
      )}
    </div>
  );
}