// Minimal asset to prove static asset routing through the ALB (→ asset-proxy Lambda → private S3).
console.log('alb-proof asset loaded');
document.addEventListener('DOMContentLoaded', () => {
  const el = document.querySelector('[data-testid="alb-marker"]');
  if (el) el.setAttribute('data-asset-loaded', 'true');
});
