import path from 'node:path';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';

const MAX_TEXT_PER_FILE = 8_000;
const supported = new Set(['.pdf', '.docx', '.txt', '.md', '.csv']);

function safeName(name) {
  return path.basename(String(name || 'proposal')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
}

export async function extractOfferText(file) {
  const name = safeName(file.originalname);
  const ext = path.extname(name).toLowerCase();
  if (!supported.has(ext)) throw new Error(`${name}: формат не поддерживается. Допустимы PDF, DOCX, TXT, MD и CSV.`);
  let text = '';
  if (ext === '.pdf') {
    if (file.buffer.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error(`${name}: файл не похож на PDF.`);
    const parsed = await pdfParse(file.buffer, { max: 12 });
    text = parsed.text;
  } else if (ext === '.docx') {
    if (file.buffer.subarray(0, 2).toString('ascii') !== 'PK') throw new Error(`${name}: файл не похож на DOCX.`);
    const parsed = await mammoth.extractRawText({ buffer: file.buffer });
    text = parsed.value;
  } else {
    text = file.buffer.toString('utf8');
  }
  text = String(text).replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new Error(`${name}: не удалось извлечь текст. Для сканированного PDF нужна OCR, которой в демо пока нет.`);
  if (text.length > MAX_TEXT_PER_FILE) text = text.slice(0, MAX_TEXT_PER_FILE);
  return { fileName: name, text };
}

const addIssue = (issues, severity, text) => issues.push({ severity, text });
const present = value => value !== null && value !== undefined && value !== '';
function sameCurrency(actual, expected) {
  const aliases = [
    ['rub','rur','руб','руб.','рубль','рубля','рублей','₽','российский рубль','российские рубли'],
    ['usd','$','доллар','доллара','долларов'],
    ['eur','€','евро']
  ];
  const norm = value => String(value || '').toLocaleLowerCase('ru-RU').replace(/[.\s]/g, '');
  const a = norm(actual), e = norm(expected);
  const group = aliases.find(items => items.some(x => norm(x) === a || norm(x) === e));
  return group ? group.some(x => norm(x) === a) && group.some(x => norm(x) === e) : a === e;
}

export function evaluateOfferReview(requirements, extractedOffers) {
  const reviewed = extractedOffers.map(offer => {
    const issues = [];
    const reqQty = Number(requirements.quantity);
    if (!present(offer.supplierName)) addIssue(issues, 'blocker', 'Не удалось определить поставщика.');
    if (!present(offer.proposalDate)) addIssue(issues, 'warning', 'В документе не найдена дата предложения.');
    if (!present(offer.validUntil)) addIssue(issues, 'warning', 'Не указан срок действия предложения.');
    if (!present(offer.supplierTaxId)) addIssue(issues, 'warning', 'Не найдены реквизиты поставщика (ИНН); проверьте их вручную.');
    if (!present(offer.productName)) addIssue(issues, 'blocker', 'Не удалось определить наименование товара.');
    if (!Number.isFinite(offer.quantity)) addIssue(issues, 'blocker', 'Не удалось определить количество товара.');
    else if (Number.isFinite(reqQty) && offer.quantity !== reqQty) addIssue(issues, 'blocker', `Количество в предложении (${offer.quantity}) не совпадает с запросом (${reqQty}).`);
    if (!Number.isFinite(offer.unitPrice)) addIssue(issues, 'blocker', 'Не найдена цена за единицу.');
    if (!Number.isFinite(offer.totalPrice)) addIssue(issues, 'blocker', 'Не найдена общая стоимость.');
    if (Number.isFinite(offer.unitPrice) && Number.isFinite(offer.quantity) && Number.isFinite(offer.totalPrice)) {
      const expectedTotal = offer.unitPrice * offer.quantity;
      if (Math.abs(expectedTotal - offer.totalPrice) > Math.max(1, expectedTotal * 0.005)) addIssue(issues, 'blocker', `Арифметика не сходится: ${offer.unitPrice} × ${offer.quantity} = ${expectedTotal}, а в документе указано ${offer.totalPrice}.`);
    }
    if (!present(offer.currency)) addIssue(issues, 'blocker', 'Не указана валюта.');
    else if (requirements.currency && !sameCurrency(offer.currency, requirements.currency)) addIssue(issues, 'blocker', `Валюта предложения (${offer.currency}) отличается от заданной (${requirements.currency}).`);
    if (!present(offer.vat)) addIssue(issues, 'warning', 'Условия по НДС не найдены; уточните, включён ли НДС в цену.');
    if (offer.specificationAssessment === 'mismatch') addIssue(issues, 'blocker', `Характеристики явно расходятся с запросом: ${offer.specificationEvidence || offer.specificationText || 'сверьте описание вручную.'}`);
    else if (offer.specificationAssessment !== 'match') addIssue(issues, 'warning', 'Недостаточно данных, чтобы подтвердить соответствие характеристик.');
    if (!Number.isFinite(offer.deliveryDays)) addIssue(issues, 'warning', 'Срок поставки в днях не определён; проверьте условие вручную.');
    else if (Number.isFinite(Number(requirements.maxDeliveryDays)) && offer.deliveryDays > Number(requirements.maxDeliveryDays)) addIssue(issues, 'blocker', `Срок поставки ${offer.deliveryDays} дней превышает заданный максимум ${requirements.maxDeliveryDays} дней.`);
    if (!Number.isFinite(offer.warrantyMonths)) addIssue(issues, 'warning', 'Срок гарантии не определён.');
    else if (Number.isFinite(Number(requirements.minWarrantyMonths)) && offer.warrantyMonths < Number(requirements.minWarrantyMonths)) addIssue(issues, 'blocker', `Гарантия ${offer.warrantyMonths} месяцев меньше заданного минимума ${requirements.minWarrantyMonths} месяцев.`);
    if (!present(offer.paymentTerms)) addIssue(issues, 'warning', 'Не найдены условия оплаты.');
    if (offer.signaturePresent !== true) addIssue(issues, 'warning', 'Подпись в извлечённом тексте не подтверждена; проверьте оригинал вручную.');

    const blocked = issues.some(issue => issue.severity === 'blocker');
    const warnings = issues.some(issue => issue.severity === 'warning');
    const status = blocked ? 'Есть несоответствия' : warnings ? 'Нужно уточнение' : 'Готово к рассмотрению';
    const recommendation = blocked ? 'Не передавать дальше без исправления или решения сотрудника.' : warnings ? 'Запросить недостающие сведения и перепроверить.' : 'Можно передать на человеческое рассмотрение; это не утверждение поставщика.';
    return { ...offer, issues, status, recommendation, reviewable: !blocked && !warnings, hasWarnings: warnings };
  });

  const candidates = reviewed.filter(item => item.reviewable && Number.isFinite(item.totalPrice)).slice().sort((a, b) => a.totalPrice - b.totalPrice);
  return {
    requirements,
    offers: reviewed,
    candidates: candidates.map(item => ({ fileName: item.fileName, supplierName: item.supplierName, totalPrice: item.totalPrice, currency: item.currency, deliveryDays: item.deliveryDays, warrantyMonths: item.warrantyMonths, status: item.status })),
    note: 'Проверка охватывает только извлечённые данные, арифметику и требования, введённые сотрудником. Она не подтверждает подлинность, полномочия подписанта, юридическую действительность или соответствие корпоративному/закупочному регламенту. Решение принимает человек.'
  };
}
