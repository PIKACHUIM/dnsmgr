import type { Session } from './api';
import { CronSettings } from './CronSettings';
import { ExpirationNoticeSettings } from './ExpirationNoticeSettings';
import { LoginCaptchaSettings } from './LoginCaptchaSettings';
import { NotifySettings } from './NotifySettings';
import { ProxySettings } from './ProxySettings';
import { SystemUpdate } from './SystemUpdate';
import { Users } from './Users';

interface Props {
  session: Session;
  onExpired: (message: string) => void;
}

export function SystemAccount({ session, onExpired }: Props) {
  return <>
    <LoginCaptchaSettings session={session} onExpired={onExpired} />
    <Users session={session} onExpired={onExpired} />
  </>;
}

export function SystemTasks({ session, onExpired }: Props) {
  return <>
    <CronSettings session={session} onExpired={onExpired} />
    <NotifySettings session={session} onExpired={onExpired} />
    <ExpirationNoticeSettings session={session} onExpired={onExpired} />
  </>;
}

export function SystemMaintenance({ session, onExpired }: Props) {
  return <>
    <ProxySettings session={session} onExpired={onExpired} />
    <SystemUpdate session={session} onExpired={onExpired} />
  </>;
}
