function calculateAcademicMetrics(courses, previousData = {}) {
  const gradePoints = { A: 5, B: 4, C: 3, D: 2, E: 1, F: 0 };
  const PASS_GRADES = new Set(['A', 'B', 'C', 'D', 'E']);
  const VALID_GRADES = new Set(['A', 'B', 'C', 'D', 'E', 'F']); // ignore W, I, -, etc.

  // Normalize a unit value into a safe number (handles strings, commas, spaces)
  const toUnit = (val) => {
    if (val == null) return 0;
    // Convert to string, trim, swap lone comma decimal to dot
    let s = String(val).trim();
    if (s && s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
    // Strip any non-numeric (keep minus and dot)
    s = s.replace(/[^\d.-]/g, '');
    const n = Number.parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  };

  const currentSemester = { TCC: 0, TCE: 0, TPE: 0 };

  for (const course of (courses || [])) {
    const unit = toUnit(course?.unit ?? course?.units ?? course?.credit ?? 0);
    const grade = String(course?.grade || '').trim().toUpperCase();

    // Skip entries that aren't real graded courses or have zero unit
    if (!VALID_GRADES.has(grade) || unit <= 0) continue;

    const point = gradePoints[grade]; // 0..5

    currentSemester.TCC += unit;          // total credits carried (attempted this sem)
    currentSemester.TPE += unit * point;  // total points earned (this sem)
    if (PASS_GRADES.has(grade)) currentSemester.TCE += unit; // credits earned (passed)
  }

  const GPAraw = currentSemester.TCC > 0 ? currentSemester.TPE / currentSemester.TCC : 0;

  const safePrevious = {
    CCC: Number(previousData?.CCC) || 0,
    CCE: Number(previousData?.CCE) || 0,
    CPE: Number(previousData?.CPE) || 0,
  };

  const cumulative = {
    CCC: currentSemester.TCC + safePrevious.CCC,
    CCE: currentSemester.TCE + safePrevious.CCE,
    CPE: currentSemester.TPE + safePrevious.CPE,
  };

  const CGPAraw = cumulative.CCC > 0 ? cumulative.CPE / cumulative.CCC : 0;

  // Round only the display values; keep internals as numbers
  const round2 = (x) => Math.round(x * 100) / 100;

  return {
    ...currentSemester,
    ...cumulative,
    GPA: round2(GPAraw),
    CGPA: round2(CGPAraw),
  };
}

export default calculateAcademicMetrics;
