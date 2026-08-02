import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { Modal, ModalButtons, ModalHeader } from '#components/common/Modal';
import { matchAmazonPurchases, parseAmazonEmail, parseAmazonJson } from '#components/amazon/amazonImport';
import type { AmazonMatch } from '#components/amazon/amazonImport';
import type { Modal as ModalType } from '#modals/modalsSlice';

type Props = Extract<ModalType, { name: 'amazon-import-review' }>['options'];

export function AmazonImportReviewModal({ transactions }: Props) {
  const { t } = useTranslation();
  const [matches, setMatches] = useState<AmazonMatch[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function onFiles(files: FileList | null) {
    if (!files) return;
    try {
      const purchases = (await Promise.all([...files].map(async file => {
        const contents = await file.text();
        return file.name.toLowerCase().endsWith('.json') ? parseAmazonJson(contents) : parseAmazonEmail(contents);
      }))).flat();
      setMatches(matchAmazonPurchases(purchases, transactions));
      setError(purchases.length === 0 ? t('No Amazon orders were found in those files.') : null);
    } catch {
      setError(t('Unable to read an Amazon JSON or email file.'));
    }
  }

  return <Modal name="amazon-import-review">
    {({ state }) => <>
      <ModalHeader title={t('Review Amazon purchases')} />
      <View style={{ width: 620, maxWidth: '80vw', gap: 12, flexDirection: 'column' }}>
        <Text><Trans>Select Amazon order JSON exports or downloaded Amazon order, shipment, and refund .eml files. Files are processed only in this window and are not saved.</Trans></Text>
        <input aria-label={t('Amazon files')} type="file" accept=".json,.eml,message/rfc822,application/json" multiple onChange={event => void onFiles(event.target.files)} />
        {error && <Text style={{ color: theme.errorText }}>{error}</Text>}
        {matches.length > 0 && <View style={{ maxHeight: 340, overflowY: 'auto', flexDirection: 'column', gap: 8 }}>
          {matches.map(match => <View key={match.purchase.id} style={{ padding: 10, border: `1px solid ${theme.tableBorder}`, borderRadius: 4, gap: 4, flexDirection: 'column' }}>
            <Text>{match.purchase.id} — {match.purchase.description}</Text>
            <Text style={{ color: theme.pageTextSubdued }}>{match.reason}{match.transaction ? `: ${match.transaction.payee ?? t('Unnamed transaction')} (${match.transaction.date})` : ''}</Text>
          </View>)}
        </View>}
        <ModalButtons style={{ marginTop: 8 }}><Button onPress={() => state.close()}><Trans>Close</Trans></Button></ModalButtons>
      </View>
    </>}
  </Modal>;
}
