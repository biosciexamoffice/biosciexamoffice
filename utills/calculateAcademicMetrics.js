// Helper function (same as before)
function calculateAcademicMetrics(courses, previousData = {}) {
  const gradePoints = { 'A': 5, 'B': 4, 'C': 3, 'D': 2, 'E': 1, 'F': 0 };
  
  const currentSemester = { TCC: 0, TCE: 0, TPE: 0 };
  
  courses.forEach(course => {
    const unit = course.unit || 0;
    const grade = (course.grade || '').toUpperCase();
    const point = gradePoints[grade] || 0;
    
    currentSemester.TCC += unit;
    currentSemester.TPE += unit * point;
    
    if (['A', 'B', 'C', 'D'].includes(grade)) {
      currentSemester.TCE += unit;
    }
  });

  currentSemester.GPA = currentSemester.TCC > 0 
    ? currentSemester.TPE / currentSemester.TCC 
    : 0;

  const safePrevious = {
    CCC: Number(previousData.CCC) || 0,
    CCE: Number(previousData.CCE) || 0,
    CPE: Number(previousData.CPE) || 0
  };

  const cumulative = {
    CCC: currentSemester.TCC + safePrevious.CCC,
    CCE: currentSemester.TCE + safePrevious.CCE,
    CPE: currentSemester.TPE + safePrevious.CPE
  };

  cumulative.CGPA = cumulative.CCC > 0 
    ? cumulative.CPE / cumulative.CCC 
    : 0;

  return {
    ...currentSemester,
    ...cumulative,
    GPA: Math.round(currentSemester.GPA * 100) / 100,
    CGPA: Math.round(cumulative.CGPA * 100) / 100
  };
}

export default calculateAcademicMetrics;