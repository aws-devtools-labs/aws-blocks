"""Small, dependency-free statistics shared by report.py and calibrate.py."""
import math
import random
import statistics

Z95 = statistics.NormalDist().inv_cdf(0.975)
MIN_COMPARABLE = 3  # Fewer passes per arm: no difference or interval is reported.
BOOTSTRAP_RESAMPLES = 2000
BOOTSTRAP_SEED = 20261021


def wilson(passes, n, z=Z95):
    """Wilson score interval for a binomial proportion; None without trials."""
    if n <= 0:
        return None
    p = passes / n
    denominator = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denominator
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator
    return max(0.0, centre - half), min(1.0, centre + half)


def median_iqr(values):
    """(median, q1, q3) with inclusive quartiles; None for an empty sample."""
    values = sorted(values)
    if not values:
        return None
    if len(values) == 1:
        return values[0], values[0], values[0]
    q1, _, q3 = statistics.quantiles(values, n=4, method='inclusive')
    return statistics.median(values), q1, q3


def cv(values):
    """Sample coefficient of variation (stdev / mean); None below two values or at zero mean."""
    if len(values) < 2:
        return None
    mean = statistics.fmean(values)
    return statistics.stdev(values) / abs(mean) if mean else None


def bootstrap_median_difference(baseline, candidate, seed=BOOTSTRAP_SEED, resamples=BOOTSTRAP_RESAMPLES):
    """Candidate − baseline difference of medians with a seeded percentile bootstrap 95% CI.

    Returns None when either arm has fewer than MIN_COMPARABLE values: too few to compare.
    """
    if len(baseline) < MIN_COMPARABLE or len(candidate) < MIN_COMPARABLE:
        return None
    rng = random.Random(seed)
    draws = sorted(
        statistics.median(rng.choices(candidate, k=len(candidate)))
        - statistics.median(rng.choices(baseline, k=len(baseline)))
        for _ in range(resamples))
    low = draws[int(0.025 * (resamples - 1))]
    high = draws[int(math.ceil(0.975 * (resamples - 1)))]
    return {'difference': statistics.median(candidate) - statistics.median(baseline), 'low': low, 'high': high}


POWER_GRID = (3, 5, 8, 10, 15, 20, 25, 30, 40, 50, 75, 100)
MIN_PILOT = 6  # Fewer pooled pilot values: too few to resample a distribution from.


def median_change_power(values, change, n, simulations=200, resamples=200, seed=BOOTSTRAP_SEED):
    """Share of simulated A/B runs, n trials per arm, in which the report's rule detects a relative median change.

    Both arms are resampled from the pooled pilot values; the candidate's draws are scaled by (1 + change). A run
    detects the change when the seeded bootstrap 95% interval of the median difference (the estimator report.py
    uses, with fewer resamples) excludes zero.
    """
    rng = random.Random(seed)
    detected = 0
    for _ in range(simulations):
        baseline = rng.choices(values, k=n)
        candidate = [v * (1 + change) for v in rng.choices(values, k=n)]
        interval = bootstrap_median_difference(baseline, candidate, seed=rng.getrandbits(32), resamples=resamples)
        detected += interval is not None and (interval['low'] > 0 or interval['high'] < 0)
    return detected / simulations


def trials_for_median_change(values, change, power=0.8, grid=POWER_GRID, **options):
    """Smallest trials per arm in `grid` reaching `power` for a relative median change; None if unknowable or > grid.

    Resampling the pilot keeps its skew and outliers, unlike a normal approximation for means. The pilot is itself
    a sample, so treat the result as an estimate, not a guarantee.
    """
    if len(values) < MIN_PILOT or change <= 0 or not any(values):
        return None
    for n in grid:
        if median_change_power(values, change, n, **options) >= power:
            return n
    return None


def trials_for_rate_drop(rate, drop, alpha=0.05, power=0.8):
    """Trials per arm to detect a pass-rate drop from `rate` to `rate - drop` (two proportions)."""
    if rate is None or drop <= 0:
        return None
    lower = rate - drop
    if lower < 0:
        return None  # The observed rate is too low for this drop to exist.
    pooled = (rate + lower) / 2
    a = statistics.NormalDist().inv_cdf(1 - alpha / 2) * math.sqrt(2 * pooled * (1 - pooled))
    b = statistics.NormalDist().inv_cdf(power) * math.sqrt(rate * (1 - rate) + lower * (1 - lower))
    return max(2, math.ceil(((a + b) / drop) ** 2))
