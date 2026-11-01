import { rollDuePeriods } from './billing.js';
import { logEvent } from './events.js';
import { num } from './util.js';

/** Background housekeeping: renew auto-renew periods, expiry reminders, log retention. */
export function createJobs({ db, settings, alerts, log }) {
  const day = (d) => new Date(d).toISOString().slice(0, 10);

  async function run() {
    try {
      const n = await rollDuePeriods(db);
      if (n) log.info(`[jobs] renewed ${n} billing period(s)`);
    } catch (e) {
      log.error('[jobs] renew failed:', e.message);
    }

    try {
      const soon = await db.query(
        `UPDATE systems SET expiry_notice_for = period_end
         WHERE archived_at IS NULL AND status = 'active' AND NOT auto_renew
           AND period_end > now() AND period_end <= now() + interval '3 days'
           AND expiry_notice_for IS DISTINCT FROM period_end
         RETURNING id, name, period_end, webhook_url`,
      );
      for (const s of soon.rows) {
        const text = `⏳ اشتراك «${s.name}» ينتهي يوم ${day(s.period_end)} والتجديد التلقائي غير مفعّل.`;
        await logEvent(db, { system_id: s.id, type: 'expiring_soon', message: text });
        await alerts.send(text, { event: 'expiring_soon', system_id: s.id });
        alerts.systemWebhook(s, { event: 'subscription.expiring', period_end: s.period_end });
      }
      const expired = await db.query(
        `UPDATE systems SET expired_notice_for = period_end
         WHERE archived_at IS NULL AND status = 'active' AND NOT auto_renew AND period_end <= now()
           AND expired_notice_for IS DISTINCT FROM period_end
         RETURNING id, name, period_end, webhook_url`,
      );
      for (const s of expired.rows) {
        const text = `🔒 انتهى اشتراك «${s.name}» — طلبات الذكاء الاصطناعي متوقفة حتى التجديد.`;
        await logEvent(db, { system_id: s.id, type: 'expired', message: text });
        await alerts.send(text, { event: 'expired', system_id: s.id });
        alerts.systemWebhook(s, { event: 'subscription.expired', period_end: s.period_end });
      }
    } catch (e) {
      log.error('[jobs] expiry notices failed:', e.message);
    }

    try {
      const s = await settings.all();
      const days = Math.max(7, num(s.log_retention_days, 90));
      await db.query(`DELETE FROM usage_logs WHERE created_at < now() - make_interval(days => $1)`, [days]);
      await db.query(`DELETE FROM events WHERE created_at < now() - interval '365 days'`);
    } catch (e) {
      log.error('[jobs] retention failed:', e.message);
    }
  }

  return {
    run,
    start(intervalMs) {
      const first = setTimeout(run, 5_000);
      const timer = setInterval(run, intervalMs);
      first.unref();
      timer.unref();
      return () => {
        clearTimeout(first);
        clearInterval(timer);
      };
    },
  };
}
