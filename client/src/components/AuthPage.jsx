import { useState } from 'react';
import LoginForm from './LoginForm';
import RegisterForm from './RegisterForm';

export default function AuthPage({ onLoginSuccess, authError }) {
  const [mode, setMode] = useState('login');

  return (
    <div className="auth-shell">
      <div className="auth-header">
        <div>
          <div className="brand">COMS</div>
          <div className="subtitle">безопасный доступ к видеозвонкам</div>
        </div>
      </div>

      {authError && <div className="auth-alert auth-alert-error">{authError}</div>}

      <div className="auth-card">
        {mode === 'login' ? (
          <LoginForm
            onLoginSuccess={onLoginSuccess}
            onSwitchToRegister={() => setMode('register')}
          />
        ) : (
          <RegisterForm
            onSwitchToLogin={() => setMode('login')}
            onRegisterSuccess={onLoginSuccess}
          />
        )}
      </div>
    </div>
  );
}