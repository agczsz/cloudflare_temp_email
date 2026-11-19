import { test, expect } from '@playwright/test';
import {
  WORKER_URL,
  createTestAddress,
  requestSendAccess,
  deleteAddress,
  deleteAddressSender,
  getAddressSender,
  updateAddressSender,
} from '../../fixtures/test-helpers';

test.describe('Send Access', () => {
  test('request send access preserves existing legacy balance rows', async ({ request }) => {
    const { jwt, address } = await createTestAddress(request, 'send-access');

    try {
      // First request — should succeed even if balance will also auto-init elsewhere.
      await requestSendAccess(request, jwt);

      // Settings report the unlimited sentinel; legacy sender rows stay intact.
      const settingsRes = await request.get(`${WORKER_URL}/api/settings`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(settingsRes.ok()).toBe(true);
      const settings = await settingsRes.json();
      expect(settings.send_balance).toBe(-1);

      // Duplicate request should stay safe and idempotent.
      const dupRes = await request.post(`${WORKER_URL}/api/request_send_mail_access`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(dupRes.ok()).toBe(true);

      const sender = await getAddressSender(request, address);
      expect(sender.balance).toBe(10);
      expect(sender.enabled).toBe(1);
    } finally {
      await deleteAddress(request, jwt);
    }
  });

  test('admin-disabled rows are not overwritten by settings or send', async ({ request }) => {
    const { jwt, address } = await createTestAddress(request, 'sa-admin-blocked');

    try {
      await requestSendAccess(request, jwt);

      const sender = await getAddressSender(request, address);
      await updateAddressSender(request, {
        address,
        address_id: sender.id,
        balance: 0,
        enabled: false,
      });

      // Reading settings must not auto-repair an admin-disabled row.
      const settingsRes = await request.get(`${WORKER_URL}/api/settings`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(settingsRes.ok()).toBe(true);
      const settings = await settingsRes.json();
      expect(settings.send_balance).toBe(-1);

      const stillDisabled = await getAddressSender(request, address);
      expect(stillDisabled.balance).toBe(0);
      expect(stillDisabled.enabled).toBe(0);

      // An admin-disabled legacy balance row no longer blocks sending.
      const sendRes = await request.post(`${WORKER_URL}/api/send_mail`, {
        headers: { Authorization: `Bearer ${jwt}` },
        data: {
          from_name: 'E2E',
          to_name: 'E2E',
          to_mail: 'recipient@test.example.com',
          subject: 'should not send',
          content: 'body',
          is_html: false,
        },
      });
      expect(sendRes.ok()).toBe(true);

      const afterSend = await getAddressSender(request, address);
      expect(afterSend.balance).toBe(0);
      expect(afterSend.enabled).toBe(0);
    } finally {
      await deleteAddress(request, jwt);
    }
  });

  test('sending after admin deletes the legacy balance row does not recreate it', async ({ request }) => {
    const { jwt, address } = await createTestAddress(request, 'send-access-deleted');

    try {
      await requestSendAccess(request, jwt);

      const sender = await getAddressSender(request, address);
      await deleteAddressSender(request, sender.id);

      const sendRes = await request.post(`${WORKER_URL}/api/send_mail`, {
        headers: { Authorization: `Bearer ${jwt}` },
        data: {
          from_name: 'E2E',
          to_name: 'E2E',
          to_mail: 'recipient@test.example.com',
          subject: `E2E reinit ${Date.now()}`,
          content: 'body',
          is_html: false,
        },
      });
      expect(sendRes.ok()).toBe(true);

      // No address-balance row is recreated by sending.
      await expect(getAddressSender(request, address)).rejects.toThrow();
    } finally {
      await deleteAddress(request, jwt);
    }
  });

  test('request send access remains idempotent for an exhausted legacy balance', async ({ request }) => {
    const { jwt, address } = await createTestAddress(request, 'sendexh');

    try {
      await requestSendAccess(request, jwt);

      const sender = await getAddressSender(request, address);
      await updateAddressSender(request, {
        address,
        address_id: sender.id,
        balance: 0,
        enabled: true,
      });

      const retryRes = await request.post(`${WORKER_URL}/api/request_send_mail_access`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(retryRes.ok()).toBe(true);
    } finally {
      await deleteAddress(request, jwt);
    }
  });
});
