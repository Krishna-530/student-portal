// Application state
let currentUser = null;
let currentUserType = null;
let currentSection = 'dashboard';
let isSidebarOpen = false;
let inactivityTimer = null;
let visualTimerInterval = null;
let remainingSeconds = 600; // 10 minutes
// coursesCache stores objects like {id, name}
let coursesCache = [];
let hasCourseCode = false; // set after fetching course schema via loadCourses
// Persist admin filter selections so they survive section re-renders
// Persist admin filter selections so they survive section re-renders
let adminFilterState = { course: '', semester: '', search: '' };
let studentSemesterFilter = null;

// Fetch latest courses and refresh any dropdowns (keeps objects with id/name)
async function loadCourses() {
    try {
        const resp = await apiCall('/admin/courses');
        if (resp && resp.success && Array.isArray(resp.courses) && resp.courses.length > 0) {
            // store raw rows so we keep course_code and other metadata
            coursesCache = resp.courses.map(c => ({ ...c }));
            // server returns whether course_code exists in schema
            hasCourseCode = !!resp.has_course_code || coursesCache.some(c => c.course_code !== undefined);
        } else {
            coursesCache = [];
        }

        // Update common selects with names
        const ids = ['assignmentCourse', 'attendanceCourse', 'markCourse', 'announcementCourse', 'examCourse', 'materialCourse', 'userCourse', 'newCourse', 'editCourse'];
        ids.forEach(id => updateSelectOptions(id, getCourses()));

        // update semester selects everywhere (1..8)
        const semIds = ['assignmentSemester', 'attendanceSemester', 'markSemester', 'announcementSemester', 'examSemester', 'materialSemester', 'newSemester', 'editSemester'];
        semIds.forEach(sid => updateSemesterDropdown(sid));

        // Update admin filter options if present
        const adminFilter = document.getElementById('adminFilterCourse');
        if (adminFilter) {
            adminFilter.innerHTML = '<option value="">-- All Courses --</option>' + getCourses().map(c => `<option value="${c}">${c}</option>`).join('');
        }
    } catch (err) {
        console.warn('Failed to load courses:', err);
        coursesCache = [];
    }
}

function changeStudentSemester(val) {
    studentSemesterFilter = val;
    showSection(currentSection);
}

// Return an array of course names (helper used by many UI parts)
function getCourses() {
    return Array.isArray(coursesCache) ? coursesCache.map(c => c.name || c) : [];
}

// Utility function to parse time strings to minutes for sorting
function parseTime(timeStr) {
    // Example timeStr: "9:00 AM - 10:00 AM" or "9:00-10:00"
    // Extract start time part before '-'
    let start = timeStr.split('-')[0].trim();
    // Normalize to 24-hour time for sorting
    let [hour, minute] = start.split(':').map(Number);
    if (start.toLowerCase().includes('pm') && hour !== 12) {
        hour += 12;
    }
    if (start.toLowerCase().includes('am') && hour === 12) {
        hour = 0;
    }
    return hour * 60 + (minute || 0);
}

// small utility: populate a select element with options
function updateSelectOptions(selectId, items) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '-- Select --';
    sel.appendChild(empty);
    items.forEach(it => {
        const o = document.createElement('option');
        o.value = it;
        o.textContent = it;
        sel.appendChild(o);
    });
}

// Render course/semester filters + search in the content header (for admin/subadmin admin pages)
function renderAdminFilters(contentActionsElem) {
    if (!contentActionsElem) return;

    // don't render twice
    if (document.getElementById('adminFiltersContainer')) return;

    const container = document.createElement('div');
    container.id = 'adminFiltersContainer';
    container.className = 'filter-bar';

    // Search Input
    const searchGroup = document.createElement('div');
    searchGroup.className = 'search-input-group';
    searchGroup.innerHTML = `
        <i class="fas fa-search"></i>
        <input type="text" id="adminFilterSearch" class="form-control" placeholder="Search..." value="${adminFilterState.search || ''}">
    `;
    const searchInput = searchGroup.querySelector('input');
    searchInput.addEventListener('input', () => { adminFilterState.search = searchInput.value; });
    // Trigger filter on Enter key
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') applyFilters();
    });

    // Course filter
    const courseSelect = document.createElement('select');
    courseSelect.id = 'adminFilterCourse';
    courseSelect.className = 'form-control';
    courseSelect.innerHTML = '<option value="">-- All Courses --</option>' +
        getCourses().map(c => `<option value="${c}" ${adminFilterState.course === c ? 'selected' : ''}>${c}</option>`).join('');
    courseSelect.addEventListener('change', () => { adminFilterState.course = courseSelect.value; });

    // Semester filter
    const semesterSelect = document.createElement('select');
    semesterSelect.id = 'adminFilterSemester';
    semesterSelect.className = 'form-control';
    semesterSelect.innerHTML = '<option value="">-- All Semesters --</option>' +
        Array.from({ length: 8 }, (_, i) => `<option value="${i + 1}" ${adminFilterState.semester === String(i + 1) ? 'selected' : ''}>Semester ${i + 1}</option>`).join('');
    semesterSelect.addEventListener('change', () => { adminFilterState.semester = semesterSelect.value; });

    // Apply button
    const applyBtn = document.createElement('button');
    applyBtn.className = 'btn btn-primary btn-sm';
    applyBtn.innerHTML = '<i class="fas fa-filter"></i> Filter';
    applyBtn.onclick = applyFilters;

    // Clear button
    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn btn-secondary btn-sm';
    clearBtn.innerHTML = '<i class="fas fa-times"></i> Clear';
    clearBtn.onclick = async () => {
        searchInput.value = '';
        courseSelect.value = '';
        semesterSelect.value = '';
        adminFilterState = { course: '', semester: '', search: '' };
        await applyFilters();
    };

    async function applyFilters() {
        try {
            adminFilterState.search = searchInput.value;
            adminFilterState.course = courseSelect.value;
            adminFilterState.semester = semesterSelect.value;

            const contentBody = document.getElementById('contentBody');
            if (!contentBody) return;
            contentBody.innerHTML = '<div class="loading-spinner" style="text-align:center;padding:1rem;"><i class="fas fa-spinner fa-spin"></i> Filtering...</div>';
            const content = await generateSectionContent(currentSection);
            contentBody.innerHTML = content;
        } catch (err) {
            console.warn('Filter apply failed', err);
            showNotification('Failed to apply filter', 'error');
        }
    }

    container.appendChild(searchGroup);
    container.appendChild(courseSelect);
    container.appendChild(semesterSelect);
    container.appendChild(applyBtn);
    container.appendChild(clearBtn);

    // Append to the contentActions (which is now a row container)
    contentActionsElem.appendChild(container);
}

function getAdminFilters() {
    return {
        course: document.getElementById('adminFilterCourse')?.value || adminFilterState.course || '',
        semester: normalizeSemester(document.getElementById('adminFilterSemester')?.value || adminFilterState.semester || ''),
        search: (document.getElementById('adminFilterSearch')?.value || adminFilterState.search || '').toLowerCase()
    };
}

// API Base URL
const API_BASE_URL = window.location.origin + '/api';


//COURSE MANAGEMENT (Missing Functions Completed)
let semestersList = [
    "1st Semester", "2nd Semester", "3rd Semester",
    "4th Semester", "5th Semester", "6th Semester",
    "7th Semester", "8th Semester"
];

// Normalize semester values for server/DB compatibility
function normalizeSemester(val) {
    if (!val) return '';
    const s = String(val).trim();
    // numeric -> formatted (1 -> "1st Semester")
    if (/^\d+$/.test(s)) {
        const n = parseInt(s, 10);
        if (n >= 1 && n <= semestersList.length) return semestersList[n - 1];
    }
    // already formatted (contains 'Semester') or custom -> return as-is
    return s;
}

// Convert formatted semester ("6th Semester") back to numeric string for select elements
function semesterToNumber(val) {
    if (!val) return '';
    const s = String(val).trim();
    for (let i = 0; i < semestersList.length; i++) {
        if (semestersList[i].toLowerCase() === s.toLowerCase()) return String(i + 1);
    }
    // fallback: if it starts with a digit, return that
    const m = s.match(/^(\d+)/);
    if (m) return m[1];
    return '';
}

// (loadCourses and getCourses are defined earlier; here we only provide helpers for dropdowns)


//Fill Course Dropdown

function updateCourseDropdown(id) {
    const box = document.getElementById(id);
    if (!box) return;

    box.innerHTML = `<option value="">Select Course</option>`;
    getCourses().forEach(course => {
        box.innerHTML += `<option value="${course}">${course}</option>`;
    });
}


//Fill Semester Dropdown

function updateSemesterDropdown(id) {
    const box = document.getElementById(id);
    if (!box) return;

    box.innerHTML = `<option value="">-- Select Semester --</option>`;
    for (let i = 1; i <= 8; i++) {
        box.innerHTML += `<option value="${i}">Semester ${i}</option>`;
    }
}

// ---------------- Courses Admin UI ----------------
async function generateCoursesContent() {
    // ensure we have latest
    await loadCourses();

    const hasCode = !!hasCourseCode;
    const rows = coursesCache.map(c => `
        <tr>
            <td>${c.id}</td>
            <td>${c.name}</td>
            ${hasCode ? `<td>${c.course_code || ''}</td>` : ''}
            <td>
                <button class="btn btn-secondary btn-sm" onclick="showEditCourseModal(${c.id})"><i class="fas fa-edit"></i></button>
                <button class="btn btn-danger btn-sm" onclick="deleteCourse(${c.id})"><i class="fas fa-trash"></i></button>
            </td>
        </tr>
    `).join('');

    return `
        <div class="content-card">
            <h3><i class="fas fa-book"></i> Courses Management</h3>
            <p>Manage the courses students can belong to. Deleting a course will clear it from any users who used it.</p>
            <table class="data-table">
            <table class="data-table">
                <thead><tr><th>ID</th><th>Course Name</th>${hasCode ? '<th>Code</th>' : ''}<th>Actions</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

// ---------------- Bulk Upload Pages ----------------
function generateBulkAddUsersContent() {
    return `
        <div class="content-card">
            <h3><i class="fas fa-users-cog"></i> Bulk Add Users</h3>
            <p>Upload a CSV/XLSX file with columns: username,password,name,email,user_type (and optional roll_number,course,semester,phone)</p>
            <div style="display:flex; gap:1rem; align-items:center; margin-top:1rem;">
                <input type="file" id="bulkUsersFile" accept=".csv,.xls,.xlsx" />
                <button class="btn btn-primary" onclick="uploadBulkUsers()">Upload</button>
                <button class="btn btn-secondary" onclick="downloadExample('users')">Download sample</button>
            </div>
            <div id="bulkUsersResult" style="margin-top:1rem;"></div>
        </div>
    `;
}

function generateBulkAddAttendanceContent() {
    return `
        <div class="content-card">
            <h3><i class="fas fa-calendar-check"></i> Bulk Add Attendance</h3>
            <p>Upload CSV/XLSX with columns: roll_number,subject,date,status (optional: course,semester)</p>
            <div style="display:flex; gap:1rem; align-items:center; margin-top:1rem;">
                <input type="file" id="bulkAttendanceFile" accept=".csv,.xls,.xlsx" />
                <button class="btn btn-primary" onclick="uploadBulkAttendance()">Upload</button>
                <button class="btn btn-secondary" onclick="downloadExample('attendance')">Download sample</button>
            </div>
            <div id="bulkAttendanceResult" style="margin-top:1rem;"></div>
        </div>
    `;
}

function generateBulkAddMarksContent() {
    return `
        <div class="content-card">
            <h3><i class="fas fa-chart-line"></i> Bulk Add Marks</h3>
            <p>Upload CSV/XLSX with columns: roll_number,subject,marks_obtained (optional: total_marks,grade,exam_type,exam_date,course,semester)</p>
            <div style="display:flex; gap:1rem; align-items:center; margin-top:1rem;">
                <input type="file" id="bulkMarksFile" accept=".csv,.xls,.xlsx" />
                <button class="btn btn-primary" onclick="uploadBulkMarks()">Upload</button>
                <button class="btn btn-secondary" onclick="downloadExample('marks')">Download sample</button>
            </div>
            <div id="bulkMarksResult" style="margin-top:1rem;"></div>
        </div>
    `;
}

async function uploadBulkUsers() {
    const fileInput = document.getElementById('bulkUsersFile');
    const result = document.getElementById('bulkUsersResult');
    result.innerHTML = '';
    if (!fileInput || !fileInput.files || !fileInput.files[0]) return showNotification('Please select a file', 'error');
    const fd = new FormData();
    fd.append('file', fileInput.files[0]);

    try {
        const res = await fetch(`${API_BASE_URL}/admin/bulk_add_users`, { method: 'POST', body: fd, credentials: 'include' });
        const data = await res.json();
        if (data.success) {
            result.innerHTML = `<div class="success-message">${data.message}</div>` + (data.failures && data.failures.length ? `<pre style="margin-top:8px;">${data.failures.join('\n')}</pre>` : '');
            showNotification('Bulk users upload finished', 'success');
        } else {
            result.innerHTML = `<div class="error-message">${data.message}</div>`;
            showNotification(data.message || 'Upload failed', 'error');
        }
    } catch (err) {
        console.error(err);
        result.innerHTML = `<div class="error-message">Network or server error</div>`;
        showNotification('Upload failed', 'error');
    }
}

async function uploadBulkAttendance() {
    const fileInput = document.getElementById('bulkAttendanceFile');
    const result = document.getElementById('bulkAttendanceResult');
    result.innerHTML = '';
    if (!fileInput || !fileInput.files || !fileInput.files[0]) return showNotification('Please select a file', 'error');
    const fd = new FormData();
    fd.append('file', fileInput.files[0]);

    try {
        const res = await fetch(`${API_BASE_URL}/admin/bulk_add_attendance`, { method: 'POST', body: fd, credentials: 'include' });
        const data = await res.json();
        if (data.success) {
            result.innerHTML = `<div class="success-message">${data.message}</div>` + (data.failures && data.failures.length ? `<pre style="margin-top:8px;">${data.failures.join('\n')}</pre>` : '');
            showNotification('Bulk attendance upload finished', 'success');
        } else {
            result.innerHTML = `<div class="error-message">${data.message}</div>`;
            showNotification(data.message || 'Upload failed', 'error');
        }
    } catch (err) {
        console.error(err);
        result.innerHTML = `<div class="error-message">Network or server error</div>`;
        showNotification('Upload failed', 'error');
    }
}

async function uploadBulkMarks() {
    const fileInput = document.getElementById('bulkMarksFile');
    const result = document.getElementById('bulkMarksResult');
    result.innerHTML = '';
    if (!fileInput || !fileInput.files || !fileInput.files[0]) return showNotification('Please select a file', 'error');
    const fd = new FormData();
    fd.append('file', fileInput.files[0]);

    try {
        const res = await fetch(`${API_BASE_URL}/admin/bulk_add_marks`, { method: 'POST', body: fd, credentials: 'include' });
        const data = await res.json();
        if (data.success) {
            result.innerHTML = `<div class="success-message">${data.message}</div>` + (data.failures && data.failures.length ? `<pre style="margin-top:8px;">${data.failures.join('\n')}</pre>` : '');
            showNotification('Bulk marks upload finished', 'success');
        } else {
            result.innerHTML = `<div class="error-message">${data.message}</div>`;
            showNotification(data.message || 'Upload failed', 'error');
        }
    } catch (err) {
        console.error(err);
        result.innerHTML = `<div class="error-message">Network or server error</div>`;
        showNotification('Upload failed', 'error');
    }
}

function downloadExample(kind) {
    // provide examples that exist in uploads/ or templates
    let url = '/uploads/test_users.csv';
    if (kind === 'attendance') url = '/uploads/test_attendance_with_course.csv';
    if (kind === 'marks') url = '/uploads/test_marks_example.csv';
    window.open(url, '_blank');
}

function showCourseManager() {
    // Reuse the admin section content as a modal for quick access
    generateCoursesContent().then(html => {
        showModal('Course Manager', html + `
            <div style="margin-top:1rem; display:flex; gap:0.5rem;">
                <button class="btn btn-primary" onclick="showAddCourseModal()">Add Course</button>
                <button class="btn btn-secondary" onclick="loadCourses(); showSection(currentSection);">Refresh</button>
            </div>
        `);
    }).catch(err => showNotification('Failed to load courses', 'error'));
}

function showAddCourseModal() {
    const content = `
        <form id="addCourseForm" onsubmit="addCourse(event)">
            <div class="form-group">
                <label>Course Name</label>
                <input type="text" id="newCourseName" required />
            </div>
            ${hasCourseCode ? `
            <div class="form-group">
                <label>Course Code (optional)</label>
                <input type="text" id="newCourseCode" placeholder="e.g. CSE101" />
            </div>
            ` : ''}
            <div class="modal-footer">
                <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button type="submit" class="btn btn-primary">Add Course</button>
            </div>
        </form>
    `;
    showModal('Add Course', content);
    document.getElementById('newCourseName')?.focus();
}

async function addCourse(e) {
    e.preventDefault();
    const name = document.getElementById('newCourseName').value.trim();
    if (!name) return showNotification('Please enter a course name', 'error');

    const payload = { name };
    if (hasCourseCode) payload.course_code = document.getElementById('newCourseCode')?.value?.trim() || '';
    const resp = await apiCall('/admin/courses', 'POST', payload);
    if (!resp) return;
    if (resp.success) {
        showNotification('Course added', 'success');
        closeModal();
        await loadCourses();
        // if we're viewing courses-admin, re-render
        if (currentSection === 'courses-admin') showSection('courses-admin');
    } else {
        showNotification(resp.message || 'Failed to add course', 'error');
    }
}

function showEditCourseModal(id) {
    const course = coursesCache.find(c => c.id === id);
    if (!course) return showNotification('Course not found', 'error');
    const content = `
        <form id="editCourseForm" onsubmit="editCourse(event, ${id})">
            <div class="form-group">
                <label>Course Name</label>
                <input type="text" id="editCourseName" value="${escapeHtml(course.name)}" required />
            </div>
            ${hasCourseCode ? `
            <div class="form-group">
                <label>Course Code</label>
                <input type="text" id="editCourseCode" value="${escapeHtml(course.course_code || '')}" />
            </div>
            ` : ''}
            <div class="modal-footer">
                <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button type="submit" class="btn btn-primary">Save</button>
            </div>
        </form>
    `;
    showModal('Edit Course', content);
    document.getElementById('editCourseName')?.focus();
}

async function editCourse(e, id) {
    e.preventDefault();
    const name = document.getElementById('editCourseName').value.trim();
    if (!name) return showNotification('Please enter a course name', 'error');

    const payload = { name };
    if (hasCourseCode) payload.course_code = document.getElementById('editCourseCode')?.value?.trim() || '';
    const resp = await apiCall(`/admin/courses/${id}`, 'PUT', payload);
    if (!resp) return;
    if (resp.success) {
        showNotification('Course updated', 'success');
        closeModal();
        await loadCourses();
        if (currentSection === 'courses-admin') showSection('courses-admin');
    } else {
        showNotification(resp.message || 'Failed to update course', 'error');
    }
}

async function deleteCourse(id) {
    if (!confirm('Delete this course? This will clear the course from users who had it.')) return;
    try {
        const res = await fetch(`${API_BASE_URL}/admin/courses/${id}`, { method: 'DELETE', credentials: 'include' });
        const data = await res.json();
        if (data && data.success) {
            showNotification('Course deleted', 'success');
            await loadCourses();
            if (currentSection === 'courses-admin') showSection('courses-admin');
        } else {
            showNotification(data?.message || 'Failed to delete course', 'error');
        }
    } catch (err) {
        console.error('deleteCourse error', err);
        showNotification('Network error when deleting course', 'error');
    }
}

// cheap HTML escape for form prefill
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": "&#39;" })[m]; });
}


// Initialize application
document.addEventListener('DOMContentLoaded', function () {
    initializeApp();
    setupEventListeners();
});

function initializeApp() {
    // Try to restore previous login from localStorage (keeps user logged in across page reloads)
    const savedUser = localStorage.getItem('currentUser');
    const savedType = localStorage.getItem('currentUserType');
    if (savedUser && savedType) {
        try {
            currentUser = JSON.parse(savedUser);
            currentUserType = savedType;
            showDashboard();
            initInactivityTimeout();
            return;
        } catch (err) {
            // If parse fails, fall back to login page
            console.warn('Failed to restore saved user:', err);
        }
    }

    showPage('loginPage');
    setupFileUpload();
}

function setupEventListeners() {
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', handleLogin);
    }

    // Modal close events
    document.addEventListener('click', function (e) {
        if (e.target.classList.contains('modal')) {
            closeModal();
            closeFileModal();
        }
    });

    // Sidebar overlay click on mobile
    document.addEventListener('click', function (e) {
        if (window.innerWidth <= 1024 && isSidebarOpen && !e.target.closest('.sidebar') && !e.target.closest('.sidebar-toggle')) {
            toggleSidebar();
        }
    });

    setupFileUpload();
}

// API Helper Functions
async function apiCall(endpoint, method = 'GET', data = null) {
    try {
        const config = {
            method,
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include'
        };

        if (data) {
            config.body = JSON.stringify(data);
        }

        const response = await fetch(`${API_BASE_URL}${endpoint}`, config);

        if (!response.ok) {
            // Try to parse JSON error message from server
            let errBody = null;
            try {
                errBody = await response.json();
            } catch (e) {
                // ignore
            }
            const msg = errBody?.message || `HTTP error! status: ${response.status}`;
            // show server-provided message
            showNotification(msg, 'error');
            return errBody || { success: false, message: msg };
        }

        return await response.json();
    } catch (error) {
        console.error('API call failed:', error);
        showNotification('Network error occurred.', 'error');
        return null;
    }
}

// Authentication
async function handleLogin(e) {
    e.preventDefault();

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const userType = document.getElementById('userType').value;

    if (!username || !password || !userType) {
        showNotification('Please fill in all fields', 'error');
        return;
    }

    const loginData = await apiCall('/auth/login', 'POST', {
        username,
        password,
        userType
    });

    if (loginData && loginData.success) {
        currentUser = loginData.user;
        currentUserType = userType;
        // persist login in localStorage so page reloads don't require re-login
        try {
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            localStorage.setItem('currentUserType', currentUserType);
            // Clear any old expiration to ensure a fresh 10 mins starts
            localStorage.removeItem('sessionExpiration');
        } catch (err) {
            console.warn('Could not persist login to localStorage', err);
        }
        showDashboard();
        initInactivityTimeout();
        showNotification('Login successful!', 'success');
    } else {
        showNotification(loginData?.message || 'Invalid credentials. Please try again.', 'error');
    }
}

function logout() {
    currentUser = null;
    currentUserType = null;
    currentSection = 'dashboard';
    // clear persisted login
    try {
        localStorage.removeItem('currentUser');
        localStorage.removeItem('currentUserType');
        localStorage.removeItem('sessionExpiration');
    } catch (err) { }

    if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
    }

    if (visualTimerInterval) {
        clearInterval(visualTimerInterval);
        visualTimerInterval = null;
    }

    showPage('loginPage');

    // Clear form
    document.getElementById('loginForm').reset();
    showNotification('Logged out successfully', 'success');
}

// Session Timer Logic
function startSessionTimer() {
    if (inactivityTimer) {
        clearTimeout(inactivityTimer);
    }

    const now = Date.now();
    let expiration = localStorage.getItem('sessionExpiration');

    if (!expiration) {
        // Set new expiration 10 minutes from now
        expiration = now + (10 * 60 * 1000);
        localStorage.setItem('sessionExpiration', expiration);
    } else {
        expiration = parseInt(expiration, 10);
    }

    remainingSeconds = Math.max(0, Math.floor((expiration - now) / 1000));

    if (remainingSeconds <= 0) {
        showNotification('Session expired. Please log in again.', 'info');
        logout();
        return;
    }

    updateVisualTimerUI();

    inactivityTimer = setTimeout(() => {
        showNotification('Session expired. Please log in again.', 'info');
        logout();
    }, remainingSeconds * 1000);

    startVisualTimer();
}

function initInactivityTimeout() {
    // Session is now fixed duration (10 mins) and won't reset on activity
    startSessionTimer();
}

function updateVisualTimerUI() {
    const timerText = document.getElementById('timerText');
    const timerProgress = document.getElementById('timerProgress');
    if (!timerText || !timerProgress) return;

    const mins = Math.floor(remainingSeconds / 60);
    const secs = remainingSeconds % 60;
    timerText.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;

    // Update circular progress (360 degrees = 100 on stroke-dasharray)
    const percentage = (remainingSeconds / 600) * 100;
    timerProgress.setAttribute('stroke-dasharray', `${percentage}, 100`);

    // Color feedback
    if (remainingSeconds < 60) {
        timerProgress.style.stroke = '#ef4444'; // Red for last minute
    } else if (remainingSeconds < 300) {
        timerProgress.style.stroke = '#f59e0b'; // Amber for < 5 mins
    } else {
        timerProgress.style.stroke = '#667eea'; // Original blue
    }
}

function startVisualTimer() {
    if (visualTimerInterval) clearInterval(visualTimerInterval);

    visualTimerInterval = setInterval(() => {
        if (remainingSeconds > 0) {
            remainingSeconds--;
            updateVisualTimerUI();
        } else {
            clearInterval(visualTimerInterval);
        }
    }, 1000);
}

function showDashboard() {
    showPage('dashboardPage');
    updateHeaderInfo();
    populateSidebar();
    // refresh cached courses so UI always reflects DB
    loadCourses();
    showSection('dashboard');
    // Load notification bell count for all user types
    loadNotifBell();
}

function updateHeaderInfo() {
    const portalTitle = document.getElementById('portalTitle');
    const currentUserName = document.getElementById('currentUserName');

    if (currentUserType === 'admin') {
        portalTitle.textContent = 'Admin Portal';
    } else if (currentUserType === 'subadmin') {
        portalTitle.textContent = 'Sub-Admin Portal';
    } else {
        portalTitle.textContent = 'Student Portal';
    }

    currentUserName.textContent = currentUser.name;
}

function populateSidebar() {
    const sidebarNav = document.getElementById('sidebarNav');
    let menuItems = [];

    if (currentUserType === 'student') {
        menuItems = [
            { id: 'dashboard', icon: 'fas fa-home', label: 'Dashboard' },
            { id: 'profile', icon: 'fas fa-user-circle', label: 'My Profile' },
            { id: 'attendance-student', icon: 'fas fa-calendar-check', label: 'My Attendance' },
            { id: 'exam-student', icon: 'fas fa-clipboard-list', label: 'Exams' },
            { id: 'marks-student', icon: 'fas fa-chart-line', label: 'My Marks & Results' },
            { id: 'materials-student', icon: 'fas fa-file-alt', label: 'Study Materials' },
            { id: 'announcements-student', icon: 'fas fa-bullhorn', label: 'Announcements' },
            { id: 'assignments-student', icon: 'fas fa-tasks', label: 'My Assignments' }
        ];
    } else if (currentUserType === 'admin') {
        menuItems = [
            { id: 'dashboard', icon: 'fas fa-home', label: 'Dashboard' },
            { id: 'profile', icon: 'fas fa-user-circle', label: 'My Profile' },
            { id: 'user-management', icon: 'fas fa-users-cog', label: 'User Management' },
            { id: 'courses-admin', icon: 'fas fa-book', label: 'Courses' },
            { id: 'assignments-admin', icon: 'fas fa-tasks', label: 'Assignments' },
            { id: 'exam-admin', icon: 'fas fa-clipboard-list', label: 'Exams' },
            { id: 'materials-admin', icon: 'fas fa-folder-open', label: 'Materials' },
            { id: 'announcements-admin', icon: 'fas fa-bullhorn', label: 'Announcements' },
            { id: 'attendance-admin', icon: 'fas fa-calendar-check', label: 'Attendance' },
            { id: 'marks-admin', icon: 'fas fa-chart-bar', label: 'Marks' }
        ];
    } else if (currentUserType === 'subadmin') {
        // sub-admin gets the admin-like menu but without bulk features AND without User/Course management
        menuItems = [
            { id: 'dashboard', icon: 'fas fa-home', label: 'Dashboard' },
            { id: 'profile', icon: 'fas fa-user-circle', label: 'My Profile' },
            { id: 'assignments-admin', icon: 'fas fa-tasks', label: 'Assignments' },
            { id: 'exam-admin', icon: 'fas fa-clipboard-list', label: 'Exams' },
            { id: 'materials-admin', icon: 'fas fa-folder-open', label: 'Materials' },
            { id: 'announcements-admin', icon: 'fas fa-bullhorn', label: 'Announcements' },
            { id: 'attendance-admin', icon: 'fas fa-calendar-check', label: 'Attendance' },
            { id: 'marks-admin', icon: 'fas fa-chart-bar', label: 'Marks' }
        ];
    }

    sidebarNav.innerHTML = menuItems.map(item => `
        <div class="sidebar-item">
            <a href="#" class="sidebar-link" onclick="showSection('${item.id}')" data-section="${item.id}">
                <i class="${item.icon}"></i>
                <span>${item.label}</span>
            </a>
        </div>
    `).join('');

    updateActiveSidebarItem('dashboard');
}

function updateActiveSidebarItem(sectionId) {
    const sidebarLinks = document.querySelectorAll('.sidebar-link');
    sidebarLinks.forEach(link => {
        link.classList.remove('active');
        if (link.dataset.section === sectionId) {
            link.classList.add('active');
        }
    });
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const main = document.querySelector('.main-content');

    if (window.innerWidth <= 1024) {
        // Mobile behavior: slide in/out
        sidebar.classList.toggle('active');
        if (main) main.classList.toggle('shifted');
        isSidebarOpen = sidebar.classList.contains('active');
    } else {
        // Desktop behavior: collapse/expand
        sidebar.classList.toggle('collapsed');
        isSidebarOpen = !sidebar.classList.contains('collapsed');
    }
}

// ==================== Section Management ====================
function getSectionInfo(sectionId) {
    const sectionMap = {
        'dashboard': { title: 'Dashboard', actions: '' },
        'profile': { title: 'My Profile', actions: '' },
        'user-management': {
            title: 'User Management',
            actions: `
                <button class="btn btn-primary" onclick="showAddUserModal()"><i class="fas fa-plus"></i> Add User</button>
                <button class="btn btn-secondary" onclick="showBulkAddModal('users')"><i class="fas fa-file-excel"></i> Bulk Add</button>
            `
        },
        'assignments-admin': {
            title: 'Assignments Management',
            actions: `
                <button class="btn btn-primary" onclick="showAddAssignmentModal()"><i class="fas fa-plus"></i> Add Assignment</button>
                <button class="btn btn-secondary" onclick="showFileUploadModal('assignments')"><i class="fas fa-upload"></i> Upload File</button>
            `
        },
        'attendance-admin': {
            title: 'Attendance Management',
            actions: `
                <button class="btn btn-primary" onclick="showAddAttendanceModal()"><i class="fas fa-plus"></i> Add Attendance</button>
                <button class="btn btn-secondary" onclick="showBulkAddModal('attendance')"><i class="fas fa-file-excel"></i> Bulk Add</button>
            `
        },
        'marks-admin': {
            title: 'Marks Management',
            actions: `
                <button class="btn btn-primary" onclick="showAddMarkModal()"><i class="fas fa-plus"></i> Add Mark</button>
                <button class="btn btn-secondary" onclick="showBulkAddModal('marks')"><i class="fas fa-file-excel"></i> Bulk Add</button>
            `
        },
        'materials-admin': {
            title: 'Study Materials Management',
            actions: `
                <button class="btn btn-primary" onclick="showAddMaterialModal()"><i class="fas fa-plus"></i> Add Material</button>
                <button class="btn btn-secondary" onclick="showFileUploadModal('materials')"><i class="fas fa-upload"></i> Upload File</button>
            `
        },
        'announcements-admin': {
            title: 'Announcements Management',
            actions: '<button class="btn btn-primary" onclick="showAddAnnouncementModal()"><i class="fas fa-plus"></i> Add Announcement</button>'
        },
        'exam-admin': {
            title: 'Exams Management',
            actions: '<button class="btn btn-primary" onclick="showAddExamModal()"><i class="fas fa-plus"></i> Add Exam</button>'
        },
        'courses-admin': {
            title: 'Courses Management',
            actions: `<button class="btn btn-primary" onclick="showAddCourseModal()"><i class="fas fa-plus"></i> Add Course</button>`
        },
        // Student sections
        'attendance-student': { title: 'My Attendance', actions: '' },
        'exam-student': { title: 'Exams', actions: '' },
        'marks-student': { title: 'My Marks & Results', actions: '' },
        'materials-student': { title: 'Study Materials', actions: '' },
        'announcements-student': { title: 'Announcements', actions: '' },
        'assignments-student': { title: 'My Assignments', actions: '' }
    };
    return sectionMap[sectionId] || { title: 'Section', actions: '' };
}

async function showSection(sectionId) {
    currentSection = sectionId;
    updateActiveSidebarItem(sectionId);

    const contentTitle = document.getElementById('contentTitle');
    const contentActions = document.getElementById('contentActions');
    const contentBody = document.getElementById('contentBody');

    if (window.innerWidth <= 1024) toggleSidebar();

    const sectionInfo = getSectionInfo(sectionId);
    contentTitle.textContent = sectionInfo.title;

    // Create two-row structure inside contentActions
    contentActions.innerHTML = `
        <div id="adminFilterRow" class="header-row"></div>
        <div id="adminButtonRow" class="header-row"></div>
    `;
    const filterRow = document.getElementById('adminFilterRow');
    const buttonRow = document.getElementById('adminButtonRow');

    buttonRow.innerHTML = sectionInfo.actions;

    // Add admin/sub-admin filters (course + semester) when viewing admin pages
    try {
        if ((currentUserType === 'admin' || currentUserType === 'subadmin') && (sectionId.endsWith('-admin') || sectionId === 'user-management')) {
            renderAdminFilters(filterRow);
        }
    } catch (err) { console.warn('renderAdminFilters failed', err); }

    // Add a compact refresh icon next to the section title
    try {
        // Remove any previous refresh btn appended to the title
        const existingBtn = document.getElementById('titleRefreshBtn');
        if (existingBtn) existingBtn.remove();

        const refreshBtn = document.createElement('button');
        refreshBtn.id = 'titleRefreshBtn';
        refreshBtn.title = 'Reload this section';
        refreshBtn.style.cssText = 'background:none; border:none; color:#94a3b8; cursor:pointer; font-size:0.9rem; margin-left:0.5rem; vertical-align: middle; padding: 0.2rem 0.4rem; border-radius: 6px; transition: color 0.2s;';
        refreshBtn.innerHTML = '<i class="fas fa-sync-alt"></i>';
        refreshBtn.onmouseover = () => refreshBtn.style.color = '#667eea';
        refreshBtn.onmouseout = () => refreshBtn.style.color = '#94a3b8';
        refreshBtn.onclick = function () { showSection(currentSection); };

        if (contentTitle) contentTitle.appendChild(refreshBtn);
    } catch (err) {
        console.warn('Could not add refresh button:', err);
    }

    // Prevent non-admins from accessing user/course management
    if ((sectionId === 'user-management' || sectionId === 'courses-admin') && currentUserType !== 'admin') {
        contentActions.innerHTML = '';
        contentBody.innerHTML = '<div class="error-message">You do not have permission to access this section. This area is reserved for Administrators only.</div>';
        return;
    }

    // Prevent sub-admins from accessing bulk pages
    if (sectionId.startsWith('bulk') && currentUserType !== 'admin') {
        contentActions.innerHTML = '';
        contentBody.innerHTML = '<div class="error-message">You do not have permission to access bulk functions.</div>';
        return;
    }
    contentBody.innerHTML = '<div class="loading-spinner" style="text-align: center; padding: 2rem;"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';

    try {
        const content = await generateSectionContent(sectionId);
        contentBody.innerHTML = content;
    } catch (error) {
        console.error('Error loading section content:', error);
        contentBody.innerHTML = '<div class="error-message">Failed to load content. Please try again.</div>';
    }
}

async function generateSectionContent(sectionId) {
    switch (sectionId) {
        case 'dashboard':
            return generateDashboardContent();
        case 'profile':
            return generateProfileContent();
        case 'user-management':
            return await generateUserManagementContent();
        case 'assignments-admin':
            return await generateAssignmentsContent();
        case 'attendance-admin':
            return await generateAttendanceContent();   // Management page
        case 'marks-admin':
            return await generateMarksContent();        // Management page
        case 'announcements-admin':
            return await generateAnnouncementsContent();
        case 'materials-admin':
            return await generateMaterialsContent();
        case 'exam-admin':
            return await generateExamContent();

        // Student sections
        case 'attendance-student':
            return await generateStudentAttendanceContent();
        case 'marks-student':
            return await generateStudentMarksContent();
        case 'exam-student':
            return await generateStudentExamsContent();
        case 'materials-student':
            return await generateStudentMaterialsContent();
        case 'announcements-student':
            return await generateStudentAnnouncementsContent();
        case 'assignments-student':
            return await generateStudentAssignmentsContent();

        case 'courses-admin':
            return await generateCoursesContent();

        default:
            return '<div class="content-card"><h3>Section Coming Soon</h3><p>This section is under development.</p></div>';
    }
}

function generateDashboardContent() {
    if (currentUserType === 'student') {
        // Returns a Promise — caller must await through generateSectionContent
        return generateStudentDashboardContent();
    } else {
        const isAdmin = currentUserType === 'admin';
        return `
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 2rem;">
                ${isAdmin ? `
                <div class="content-card">
                    <h3><i class="fas fa-users"></i> User Management</h3>
                    <p>Add, edit, and manage student and staff accounts.</p>
                    <a href="#" onclick="showSection('user-management')" class="btn btn-primary" style="text-decoration: none;">Manage Users</a>
                </div>
                ` : ''}
                <div class="content-card">
                    <h3><i class="fas fa-chart-bar"></i> Academic Data</h3>
                    <p>Manage attendance, marks, assignments, and more.</p>
                    <a href="#" onclick="showSection('marks-admin')" class="btn btn-secondary" style="text-decoration: none;">Manage Data</a>
                </div>
            </div>
            ${isAdmin ? `
            <div class="content-card">
                <h3><i class="fas fa-book"></i> Course Manager</h3>
                <p>Add, rename, or delete courses for students.</p>
                <a href="#" onclick="showCourseManager()" class="btn btn-success" style="text-decoration: none;">Open Course Manager</a>
            </div>
            ` : ''}
        `;
    }
}

function generateProfileContent() {
    return `
        <div class="content-card">
            <div class="profile-header">
                <div class="profile-avatar">
                    <i class="fas fa-user"></i>
                </div>
                <div>
                    <h3>${currentUser.name}</h3>
                    <p style="color: #64748b; margin: 0.5rem 0;">${currentUserType.charAt(0).toUpperCase() + currentUserType.slice(1)}</p>
                    <p style="color: #64748b; margin: 0;"><i class="fas fa-envelope"></i> ${currentUser.email}</p>
                </div>
            </div>
            
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1.5rem;">
                <div class="detail-card">
                    <h4>Personal Information</h4>
                    <div class="detail-item">
                        <span class="detail-label">Username:</span>
                        <span class="detail-value">${currentUser.username}</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Email:</span>
                        <span class="detail-value">${currentUser.email}</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">User Type:</span>
                        <span class="detail-value">${currentUserType}</span>
                    </div>
                </div>
                
                ${currentUserType === 'student' ? `
                <div class="detail-card">
                    <h4>Academic Information</h4>
                    <div class="detail-item">
                        <span class="detail-label">Roll Number:</span>
                        <span class="detail-value">${currentUser.roll_number || 'N/A'}</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Course:</span>
                        <span class="detail-value">${currentUser.course || 'N/A'}</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Semester:</span>
                        <span class="detail-value">${currentUser.semester || 'N/A'}</span>
                    </div>
                </div>
                ` : ''}
            </div>
        </div>
    `;
}

// ==================== Student Content Functions ====================
async function generateStudentAttendanceContent() {
    console.log('Fetching attendance for student ID:', currentUser.id);
    const data = await apiCall(`/student/attendance/${currentUser.id}`);
    if (!data || !data.success) {
        return '<div class="content-card"><p>No attendance data available or failed to load data.</p></div>';
    }

    const allRecords = Array.isArray(data.attendance) ? data.attendance : [];

    // Default filter to student's current semester if not set
    if (studentSemesterFilter === null) {
        studentSemesterFilter = currentUser.semester || '1';
    }

    // Filter records by selected semester
    const attendanceRecords = allRecords.filter(r => String(r.semester) === String(studentSemesterFilter));

    let filterHtml = `
        <div class="content-card" style="margin-bottom: 1.5rem;">
            <div style="display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;">
                <label style="font-weight: 600;">Select Semester:</label>
                <select class="form-control" style="width: auto; min-width: 150px;" onchange="changeStudentSemester(this.value)">
                    ${[1, 2, 3, 4, 5, 6, 7, 8].map(s => `<option value="${s}" ${String(studentSemesterFilter) === String(s) ? 'selected' : ''}>Semester ${s}</option>`).join('')}
                </select>
            </div>
        </div>
    `;

    if (attendanceRecords.length === 0) {
        return filterHtml + '<div class="content-card"><h3><i class="fas fa-calendar-check"></i> My Attendance Record</h3><p>No attendance records found for Semester ' + studentSemesterFilter + '.</p></div>';
    }

    // Calculate overall stats
    const totalDays = attendanceRecords.length;
    const presentDays = attendanceRecords.filter(r => r.status === 'present').length;
    const attendancePercentage = ((presentDays / totalDays) * 100).toFixed(1);

    // Group by subject
    const subjects = {};
    attendanceRecords.forEach(record => {
        if (!subjects[record.subject]) {
            subjects[record.subject] = { total: 0, present: 0 };
        }
        subjects[record.subject].total++;
        if (record.status === 'present') subjects[record.subject].present++;
    });

    let subjectBreakdownHtml = '';
    for (const [subjectName, stats] of Object.entries(subjects)) {
        const subPercentage = ((stats.present / stats.total) * 100).toFixed(1);
        const barColor = subPercentage >= 75 ? '#22c55e' : subPercentage >= 50 ? '#f59e0b' : '#ef4444';

        subjectBreakdownHtml += `
            <div class="subject-section" style="margin-bottom: 0.75rem;">
                <div class="subject-header" style="padding: 0.5rem 1rem;">
                    <h4 style="font-size: 0.95rem;">${subjectName}</h4>
                    <div class="subject-stats">
                        <span style="font-size:0.85rem; color:#64748b;">${stats.present}/${stats.total} classes</span>
                        <span class="percentage-badge" style="background:${barColor};">${subPercentage}%</span>
                    </div>
                </div>
            </div>
        `;
    }

    return filterHtml + `
        <div class="stats-grid" style="gap: 1rem; margin-bottom: 1rem;">
            <div class="summary-card" style="padding: 1rem; gap: 1rem;">
                <div class="summary-icon" style="width: 44px; height: 44px; font-size: 1.1rem;"><i class="fas fa-percentage"></i></div>
                <div class="summary-info">
                    <h4>Overall Attendance</h4>
                    <div class="value" style="font-size: 1.4rem;">${attendancePercentage}%</div>
                </div>
            </div>
            <div class="summary-card" style="padding: 1rem; gap: 1rem;">
                <div class="summary-icon" style="width: 44px; height: 44px; font-size: 1.1rem;"><i class="fas fa-check-circle"></i></div>
                <div class="summary-info">
                    <h4>Total Present</h4>
                    <div class="value" style="font-size: 1.4rem;">${presentDays} / ${totalDays}</div>
                </div>
            </div>
        </div>
        <div class="content-card" style="padding: 1rem;">
            <h3 style="font-size: 1rem; margin-bottom: 0.75rem;"><i class="fas fa-book"></i> Subject-wise Breakdown</h3>
            ${subjectBreakdownHtml}
        </div>
    `;
}




async function generateStudentMaterialsContent() {
    const data = await apiCall('/student/materials');
    if (!data || !data.success) {
        return '<div class="content-card"><p>No materials available or failed to load data.</p></div>';
    }
    const materials = sortNewestFirst(Array.isArray(data.materials) ? data.materials.slice() : [], { dateField: 'created_at' });
    const rows = materials.map(mat => `
        <tr>
            <td>${mat.title}</td>
            <td>${mat.subject}</td>
            <td>${mat.file_type}</td>
            <td>${(mat.file_size / 1024).toFixed(1)} KB</td>
            <td>
                <a href="/api/admin/download_material/${mat.id}" class="btn btn-primary btn-sm" download>
                    <i class="fas fa-download"></i> Download
                </a>
            </td>
        </tr>
    `).join('');
    return `
        <div class="content-card">
            <h3><i class="fas fa-folder-open"></i> Study Materials</h3>
            <table class="data-table">
                <thead>
                    <tr><th>Title</th><th>Subject</th><th>Type</th><th>Size</th><th>Actions</th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

async function generateStudentExamsContent() {
    const data = await apiCall('/student/exams');
    if (!data || !data.success) {
        return '<div class="content-card"><p>No exams available or failed to load data.</p></div>';
    }

    // sort exams newest-first by exam_date
    const exams = sortNewestFirst(Array.isArray(data.exams) ? data.exams.slice() : [], { dateField: 'exam_date' });
    const rows = exams.map(ex => `
        <tr>
            <td>${ex.subject}</td>
            <td>${ex.exam_type || 'N/A'}</td>
            <td>${ex.course || 'All'}</td>
            <td>${ex.semester || 'All'}</td>
            <td>${ex.exam_date ? new Date(ex.exam_date).toLocaleDateString() : 'N/A'}</td>
            <td>${ex.description || ''}</td>
        </tr>
    `).join('');

    return `
        <div class="content-card">
            <h3><i class="fas fa-clipboard-list"></i> Exams</h3>
            <table class="data-table">
                <thead>
                    <tr>
                        <th>Subject</th>
                        <th>Type</th>
                        <th>Course</th>
                        <th>Semester</th>
                        <th>Date</th>
                        <th>Description</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

async function generateStudentAssignmentsContent() {
    const data = await apiCall(`/student/assignments/${currentUser.id}`);
    if (!data || !data.success) {
        return '<div class="content-card"><p>No assignments available or failed to load data.</p></div>';
    }
    // newest-first by created_at or id
    const assignments = sortNewestFirst(Array.isArray(data.assignments) ? data.assignments.slice() : [], { dateField: 'created_at' });
    const rows = assignments.map(assgn => `
        <tr>
            <td>${assgn.title}</td>
            <td>${assgn.subject}</td>
            <td>${assgn.due_date || 'No deadline'}</td>
            <td>
                <span class="btn btn-sm ${assgn.submission_status === 'Submitted' ? 'btn-success' : 'btn-warning'}">
                    ${assgn.submission_status || 'Not Submitted'}
                </span>
            </td>
            <td>
                ${assgn.file_path ? `<button class="btn btn-primary btn-sm download-assignment-btn" data-id="${assgn.id}" data-name="${(assgn.file_path || assgn.title).toString().replace(/"/g, '&quot;')}"><i class="fas fa-download"></i> Download</button>` : `<button class="btn btn-primary btn-sm" disabled><i class="fas fa-download"></i> Download</button>`}
            </td>
        </tr>
    `).join('');
    return `
        <div class="content-card">
            <h3><i class="fas fa-tasks"></i> My Assignments</h3>
            <table class="data-table">
                <thead>
                    <tr>
                        <th>Title</th>
                        <th>Subject</th>
                        <th>Due Date</th>
                        <th>Status</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

// Student: Marks view
async function generateStudentMarksContent() {
    console.log('Fetching marks for student ID:', currentUser.id);
    const data = await apiCall(`/student/marks/${currentUser.id}`);
    if (!data || !data.success) {
        return '<div class="content-card"><p>No marks available or failed to load data.</p></div>';
    }

    const allRecords = Array.isArray(data.marks) ? data.marks : [];

    // Default filter to student's current semester if not set
    if (studentSemesterFilter === null) {
        studentSemesterFilter = currentUser.semester || '1';
    }

    // Filter records by selected semester
    const marksRecords = allRecords.filter(m => String(m.semester) === String(studentSemesterFilter));

    let filterHtml = `
        <div class="content-card" style="margin-bottom: 1.5rem;">
            <div style="display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;">
                <label style="font-weight: 600;">Select Semester:</label>
                <select class="form-control" style="width: auto; min-width: 150px;" onchange="changeStudentSemester(this.value)">
                    ${[1, 2, 3, 4, 5, 6, 7, 8].map(s => `<option value="${s}" ${String(studentSemesterFilter) === String(s) ? 'selected' : ''}>Semester ${s}</option>`).join('')}
                </select>
            </div>
        </div>
    `;

    if (marksRecords.length === 0) {
        return filterHtml + '<div class="content-card"><h3><i class="fas fa-chart-line"></i> My Marks</h3><p>No marks found for Semester ' + studentSemesterFilter + '.</p></div>';
    }

    // Group by subject
    const subjects = {};
    let totalMarksObtained = 0;
    let totalMaxMarks = 0;

    marksRecords.forEach(m => {
        if (!subjects[m.subject]) {
            subjects[m.subject] = [];
        }
        subjects[m.subject].push(m);
        totalMarksObtained += parseFloat(m.marks_obtained || 0);
        totalMaxMarks += parseFloat(m.total_marks || 100);
    });

    const overallPercentage = ((totalMarksObtained / totalMaxMarks) * 100).toFixed(1);

    let subjectBreakdownHtml = '';
    for (const [subjectName, marksList] of Object.entries(subjects)) {
        let subObtained = 0;
        let subTotal = 0;

        const rows = marksList.map(m => {
            subObtained += parseFloat(m.marks_obtained || 0);
            subTotal += parseFloat(m.total_marks || 100);
            return `
                <tr>
                    <td>${m.exam_type || 'N/A'}</td>
                    <td>${m.marks_obtained}/${m.total_marks}</td>
                    <td>${m.grade || 'N/A'}</td>
                    <td>${m.exam_date ? new Date(m.exam_date).toLocaleDateString() : 'N/A'}</td>
                </tr>
            `;
        }).join('');

        const subPercentage = ((subObtained / subTotal) * 100).toFixed(1);

        subjectBreakdownHtml += `
            <div class="subject-section">
                <div class="subject-header">
                    <h4>${subjectName}</h4>
                    <div class="subject-stats">
                        <span>Total: ${subObtained}/${subTotal}</span>
                        <span class="percentage-badge">${subPercentage}%</span>
                    </div>
                </div>
                <table class="data-table">
                    <thead>
                        <tr><th>Exam Type</th><th>Marks</th><th>Grade</th><th>Date</th></tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
    }

    return filterHtml + `
        <div class="stats-grid">
            <div class="summary-card">
                <div class="summary-icon"><i class="fas fa-trophy"></i></div>
                <div class="summary-info">
                    <h4>Overall Score</h4>
                    <div class="value">${overallPercentage}%</div>
                </div>
            </div>
            <div class="summary-card">
                <div class="summary-icon"><i class="fas fa-chart-bar"></i></div>
                <div class="summary-info">
                    <h4>Exams Taken</h4>
                    <div class="value">${marksRecords.length}</div>
                </div>
            </div>
        </div>
        <div class="content-card">
            <h3><i class="fas fa-chart-line"></i> Academic Performance</h3>
            ${subjectBreakdownHtml}
            ${buildGradeCalculator(marksRecords)}
        </div>
    `;
}


// Fetch assignment file and trigger download; handle JSON error responses gracefully
async function downloadAssignment(assignmentId, fallbackName) {
    try {
        const url = `${API_BASE_URL}/admin/download_assignment/${assignmentId}`;
        const resp = await fetch(url, { method: 'GET', credentials: 'include' });

        // If server returned JSON (error), show message
        const contentType = resp.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            const j = await resp.json().catch(() => null);
            const msg = j?.message || 'Failed to download file';
            showNotification(msg, 'error');
            return;
        }

        // Otherwise treat as binary blob
        const blob = await resp.blob();

        // try to extract filename from Content-Disposition
        const cd = resp.headers.get('content-disposition') || '';
        let filename = fallbackName || 'download';
        const m = /filename\*=UTF-8''([^;\n\r]*)/.exec(cd) || /filename="?([^";\n\r]+)"?/.exec(cd);
        if (m && m[1]) {
            try { filename = decodeURIComponent(m[1]); } catch (e) { filename = m[1]; }
        }

        // Create temporary link to download blob
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
    } catch (err) {
        console.error('Download failed', err);
        showNotification('Download failed', 'error');
    }
}

// Delegated click handler for assignment download buttons (avoids inline onclick issues)
document.addEventListener('click', function (evt) {
    const btn = evt.target.closest && evt.target.closest('.download-assignment-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    const name = btn.dataset.name;
    if (!id) return;
    // call the download helper
    downloadAssignment(id, name || 'download');
});

// Student: Announcements view
async function generateStudentAnnouncementsContent() {
    const data = await apiCall('/student/announcements');
    if (!data || !data.success) {
        return '<div class="content-card"><p>No announcements available or failed to load data.</p></div>';
    }

    const announcements = sortNewestFirst(Array.isArray(data.announcements) ? data.announcements.slice() : [], { dateField: 'created_at' });
    const items = announcements.map(ann => `
        <div class="announcement-card">
            <h4>${ann.title}</h4>
            <p>${ann.content}</p>
            <p style="margin-top: 1rem; font-size: 0.9rem; color: #64748b;"><em>Priority: ${ann.priority.toUpperCase()} | Created: ${new Date(ann.created_at).toLocaleDateString()}</em></p>
        </div>
    `).join('');

    return `
        <div class="content-card">
            <h3><i class="fas fa-bullhorn"></i> Latest Announcements</h3>
            <div>${items}</div>
        </div>
    `;
}

// ==================== Admin Content Functions ====================

// User Management
async function generateUserManagementContent() {
    const data = await apiCall('/admin/get_users');
    if (!data || !data.success) return `<div class="error-message">Failed to load users</div>`;
    // apply admin filters to users (filter students by course/semester/search)
    const filters = getAdminFilters();
    let users = data.users || [];
    if (filters.search) {
        const s = filters.search.toLowerCase();
        users = users.filter(u =>
            (u.name || '').toLowerCase().includes(s) ||
            (u.username || '').toLowerCase().includes(s) ||
            (u.roll_number || '').toLowerCase().includes(s)
        );
    }
    if (filters.course) users = users.filter(u => (u.course || '').toLowerCase() === filters.course.toLowerCase());
    if (filters.semester) users = users.filter(u => String(u.semester) === String(filters.semester));

    const rows = users.map(u => `
        <tr>
            <td>${u.username}</td>
            <td>${u.name}</td>
            <td>${u.email}</td>
            <td><span class="btn btn-sm btn-${u.user_type === 'admin' ? 'primary' : u.user_type === 'student' ? 'success' : 'secondary'}">${u.user_type}</span></td>
            <td>${u.user_type === 'student' ? u.roll_number || '' : ''}</td>
            <td>${u.user_type === 'student' ? u.course || '' : ''}</td>
            <td>${u.user_type === 'student' ? u.semester || '' : ''}</td>
            <td>${u.user_type === 'student' ? u.phone || '' : ''}</td>
            <td>
                <button class="btn btn-secondary btn-sm" onclick="editUser(${u.id})"><i class="fas fa-edit"></i></button>
                <button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id})"><i class="fas fa-trash"></i></button>
            </td>
        </tr>
    `).join('');

    return `
        <div class="content-card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                <h3><i class="fas fa-users-cog"></i> User Management</h3>
                <div>
                    <button class="btn btn-primary" onclick="showAddUserModal()" style="margin-right: 0.5rem;"><i class="fas fa-plus"></i> Add User</button>
                    <button class="btn btn-secondary" onclick="showFileUploadModal('users')" style="margin-right: 0.5rem;"><i class="fas fa-file-upload"></i> Bulk Upload (CSV)</button>
                    <button class="btn btn-success" onclick="downloadTableAsCSV('#usersTable', 'users_export.csv')"><i class="fas fa-file-download"></i> Export CSV</button>
                </div>
            </div>
            <div class="table-responsive">
                <table class="data-table" id="usersTable">
                    <thead>
                        <tr>
                            <th>User</th>
                            <th>Name</th>
                            <th>Email</th>
                            <th>Type</th>
                            <th>Roll No</th>
                            <th>Course</th>
                            <th>Semester</th>
                            <th>Phone</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>
    `;
}

async function loadUsers() {
    document.getElementById('contentBody').innerHTML = await generateUserManagementContent();
}

function toggleStudentFields() {
    const userType = document.getElementById('newUserType').value;
    const studentFields = document.getElementById('studentFields');
    if (userType === 'student') {
        studentFields.style.display = 'block';
    } else {
        studentFields.style.display = 'none';
    }
}

function showAddUserModal() {
    const content = `
        <form id="addUserForm" onsubmit="addUser(event)">

            <div class="form-group">
                    <label>User Type</label>
                    <select id="newUserType" required onchange="toggleStudentFields()">
                        <option value="">Select Type</option>
                        <option value="student">Student</option>
                        <option value="admin">Admin</option>
                        <option value="subadmin">Sub-Admin</option>
                    </select>
                </div>
            <div class="form-grid">
                <div class="form-group">
                    <label>Username</label>
                    <input type="text" id="newUsername" required>
                </div>
                <div class="form-group">
                    <label>Password</label>
                    <input type="password" id="newPassword" required>
                </div>
                <div class="form-group">
                    <label>Full Name</label>
                    <input type="text" id="newName" required>
                </div>
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" id="newEmail" required>
                </div>
                
                <div id="studentFields" style="display: none;">
                    <div class="form-group">
                        <label>Roll Number</label>
                        <input type="text" id="newRollNumber">
                    </div>
                    <div class="form-group">
                        <label>Course</label>
                        <select id="newCourse" required>
                            <!-- Course options will be populated dynamically -->
                        </select>
                        <button type="button" class="btn btn-link" onclick="showCourseManager()">Manage Courses</button>
                    </div>
                    <div class="form-group">
                        <label>Semester</label>
                        <select id="newSemester" required>
                            <option value="">-- Select Semester --</option>
                            <option value="1">Semester 1</option>
                            <option value="2">Semester 2</option>
                            <option value="3">Semester 3</option>
                            <option value="4">Semester 4</option>
                            <option value="5">Semester 5</option>
                            <option value="6">Semester 6</option>
                            <option value="7">Semester 7</option>
                            <option value="8">Semester 8</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Phone</label>
                        <input type="text" id="newPhone">
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button type="submit" class="btn btn-primary">Add User</button>
            </div>
        </form>
    `;
    showModal('Add New User', content);
    document.getElementById('newUserType').addEventListener('change', toggleStudentFields);
    // populate course and semester dropdowns dynamically for Add User
    loadCourses().then(() => {
        updateSelectOptions('newCourse', getCourses());
        updateSemesterDropdown('newSemester');
    });
}

async function addUser(e) {
    e.preventDefault();
    const userData = {
        username: document.getElementById('newUsername').value,
        password: document.getElementById('newPassword').value,
        name: document.getElementById('newName').value,
        email: document.getElementById('newEmail').value,
        user_type: document.getElementById('newUserType').value
    };

    // Client-side validation to avoid bad requests
    const required = ['username', 'password', 'name', 'email', 'user_type'];
    for (const k of required) {
        if (!userData[k] || String(userData[k]).trim() === '') {
            showNotification(`Please provide ${k.replace('_', ' ')}`, 'error');
            return;
        }
    }

    // Basic email format check
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(userData.email)) {
        showNotification('Please provide a valid email address', 'error');
        return;
    }

    // Log payload for debugging (will help diagnose 400s)
    console.debug('addUser payload:', userData);

    // Add student-specific fields if user type is student
    if (userData.user_type === 'student') {
        userData.roll_number = document.getElementById('newRollNumber').value;
        userData.course = document.getElementById('newCourse').value;
        userData.semester = normalizeSemester(document.getElementById('newSemester').value);
        userData.phone = document.getElementById('newPhone').value;
    }

    const result = await apiCall('/admin/add_user', 'POST', userData);
    if (result && result.success) {
        closeModal();
        await loadUsers();
        showNotification('User added successfully', 'success');
    } else {
        showNotification(result?.message || 'Failed to add user', 'error');
    }
}

async function deleteUser(id) {
    if (!confirm('Are you sure you want to delete this user?')) return;

    try {
        const result = await apiCall(`/admin/delete_user/${id}`, 'DELETE');
        if (result && result.success) {
            await loadUsers();
            showNotification('User deleted successfully', 'success');
        } else {
            showNotification(result?.message || 'Failed to delete user', 'error');
        }
    } catch (error) {
        console.error('Delete user error:', error);
        showNotification('Failed to delete user. Please try again.', 'error');
    }
}

// Add other admin functions (simplified for space)
async function generateAssignmentsContent() {
    // Request assignments with server-side filters when available
    const filters = getAdminFilters();
    let qs = '';
    if (filters.course) qs += `course=${encodeURIComponent(filters.course)}`;
    if (filters.semester) qs += (qs ? '&' : '') + `semester=${encodeURIComponent(filters.semester)}`;
    const endpoint = qs ? `/admin/get_assignments?${qs}` : '/admin/get_assignments';
    const data = await apiCall(endpoint);
    if (!data || !data.success) return `<div class="error-message">Failed to load assignments</div>`;
    // apply admin filters (course/semester/search) if selected
    let items = Array.isArray(data.assignments) ? data.assignments.slice() : [];
    if (filters.search) {
        const s = filters.search.toLowerCase();
        items = items.filter(a =>
            (a.title || '').toLowerCase().includes(s) ||
            (a.subject || '').toLowerCase().includes(s)
        );
    }
    // If server didn't apply filters (older schema), fall back to client-side filtering
    if (filters.course) items = items.filter(a => (a.course || '').toLowerCase() === filters.course.toLowerCase());
    if (filters.semester) items = items.filter(a => String(a.semester) === String(filters.semester));

    // Ensure newest assignments appear first (prefer created_at, fallback to id)
    items = sortNewestFirst(items, { dateField: 'created_at' });

    const rows = items.map(a => `
        <tr>
            <td>${a.title}</td>
            <td>${a.subject}</td>
            <td>${a.due_date || 'No deadline'}</td>
            <td>
                <button class="btn btn-danger btn-sm" onclick="deleteAssignment(${a.id})">
                    <i class="fas fa-trash"></i>
                </button>
                ${a.file_path ? `<button class="btn btn-primary btn-sm download-assignment-btn" data-id="${a.id}" data-name="${(a.file_path).toString().replace(/"/g, '&quot;')}"><i class="fas fa-download"></i> Download</button>` : ''}
            </td>
        </tr>
    `).join('');

    // add an admin-visible upload button inside the content in case the action bar is not visible
    const adminActions = (currentUserType === 'admin' || currentUserType === 'subadmin') ? `
        <div style="margin-bottom: 1rem;">
            <button class="btn btn-secondary" onclick="showFileUploadModal('assignments')"><i class="fas fa-upload"></i> Upload File</button>
        </div>
    ` : '';

    return `
        <div class="content-card">
            <h3><i class="fas fa-tasks"></i> Assignments</h3>
            ${adminActions}
            <table class="data-table">
                <thead>
                    <tr><th>Title</th><th>Subject</th><th>Due Date</th><th>Actions</th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

async function generateAttendanceContent() {
    const data = await apiCall('/admin/get_attendance');
    if (!data || !data.success) return `<div class="error-message">Failed to load attendance</div>`;
    // apply admin filters
    const filtersA = getAdminFilters();
    let attendanceItems = Array.isArray(data.attendance) ? data.attendance.slice() : [];
    if (filtersA.search) {
        const s = filtersA.search.toLowerCase();
        attendanceItems = attendanceItems.filter(r =>
            String(r.student_id).toLowerCase().includes(s) ||
            (r.subject || '').toLowerCase().includes(s)
        );
    }
    if (filtersA.course) attendanceItems = attendanceItems.filter(r => (r.course || '').toLowerCase() === filtersA.course.toLowerCase());
    if (filtersA.semester) attendanceItems = attendanceItems.filter(r => String(r.semester) === String(filtersA.semester));

    // newest-first by date
    attendanceItems = sortNewestFirst(attendanceItems, { dateField: 'date' });

    const rows = attendanceItems.map(a => `
        <tr>
            <td>${a.student_id}</td>
            <td>${a.subject}</td>
            <td>${a.date}</td>
            <td><span class="status-${a.status}">${a.status.toUpperCase()}</span></td>
            <td>
                <button class="btn btn-danger btn-sm" onclick="deleteAttendance(${a.id})">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        </tr>
    `).join('');

    return `
        <div class="content-card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                <h3><i class="fas fa-calendar-check"></i> Attendance Records</h3>
                <div>
                    <button class="btn btn-primary" onclick="showAddAttendanceModal()" style="margin-right: 0.5rem;"><i class="fas fa-plus"></i> Add Entry</button>
                    <button class="btn btn-success" onclick="downloadTableAsCSV('#attendanceTable', 'attendance_export.csv')"><i class="fas fa-file-download"></i> Export CSV</button>
                </div>
            </div>
            <table class="data-table" id="attendanceTable">
                <thead>
                    <tr><th>Student ID</th><th>Subject</th><th>Date</th><th>Status</th><th>Actions</th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

async function generateMarksContent() {
    const data = await apiCall('/admin/get_marks');
    if (!data || !data.success) return `<div class="error-message">Failed to load marks</div>`;
    // apply admin filters
    const filtersM = getAdminFilters();
    let markItems = Array.isArray(data.marks) ? data.marks.slice() : [];
    if (filtersM.search) {
        const s = filtersM.search.toLowerCase();
        markItems = markItems.filter(m =>
            String(m.student_id).toLowerCase().includes(s) ||
            (m.subject || '').toLowerCase().includes(s)
        );
    }
    if (filtersM.course) markItems = markItems.filter(m => (m.course || '').toLowerCase() === filtersM.course.toLowerCase());
    if (filtersM.semester) markItems = markItems.filter(m => String(m.semester) === String(filtersM.semester));

    // newest-first by exam_date (fallback to created_at/id)
    markItems = sortNewestFirst(markItems, { dateField: 'exam_date' });

    const rows = markItems.map(m => `
        <tr>
            <td>${m.student_id}</td>
            <td>${m.subject}</td>
            <td>${m.exam_type || 'N/A'}</td>
            <td>${m.marks_obtained}/${m.total_marks}</td>
            <td>${m.grade || 'N/A'}</td>
            <td>
                <button class="btn btn-danger btn-sm" onclick="deleteMark(${m.id})">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        </tr>
    `).join('');

    return `
        <div class="content-card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                <h3><i class="fas fa-chart-bar"></i> Student Marks</h3>
                <div>
                    <button class="btn btn-success" onclick="downloadTableAsCSV('#marksTable', 'marks_export.csv')"><i class="fas fa-file-download"></i> Export CSV</button>
                </div>
            </div>
            <table class="data-table" id="marksTable">
                <thead>
                    <tr><th>Student</th><th>Subject</th><th>Exam</th><th>Marks</th><th>Grade</th><th>Actions</th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

async function generateAnnouncementsContent() {
    const data = await apiCall('/admin/get_announcements');
    if (!data || !data.success) return `<div class="error-message">Failed to load announcements</div>`;
    const announcements = sortNewestFirst(Array.isArray(data.announcements) ? data.announcements.slice() : [], { dateField: 'created_at' });

    const rows = announcements.map(a => `
        <tr>
            <td>${a.title}</td>
            <td>${a.content}</td>
            <td><span class="btn btn-sm btn-${a.priority === 'high' ? 'danger' : a.priority === 'medium' ? 'warning' : 'secondary'}">${a.priority.toUpperCase()}</span></td>
            <td>${new Date(a.created_at).toLocaleDateString()}</td>
            <td>
                <button class="btn btn-danger btn-sm" onclick="deleteAnnouncement(${a.id})">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        </tr>
    `).join('');

    return `
        <div class="content-card">
            <h3><i class="fas fa-bullhorn"></i> Announcements</h3>
            <table class="data-table">
                <thead>
                    <tr><th>Title</th><th>Content</th><th>Priority</th><th>Created</th><th>Actions</th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

async function generateMaterialsContent() {
    const data = await apiCall('/admin/get_materials');
    if (!data || !data.success) return `<div class="error-message">Failed to load materials</div>`;

    // apply admin filters
    const filters = getAdminFilters();
    let items = Array.isArray(data.materials) ? data.materials.slice() : [];
    if (filters.search) {
        const s = filters.search.toLowerCase();
        items = items.filter(m =>
            (m.title || '').toLowerCase().includes(s) ||
            (m.subject || '').toLowerCase().includes(s)
        );
    }
    if (filters.course) items = items.filter(m => (m.course || '').toLowerCase() === filters.course.toLowerCase());
    if (filters.semester) items = items.filter(m => String(m.semester) === String(filters.semester));

    // newest-first by created_at
    items = sortNewestFirst(items, { dateField: 'created_at' });

    const rows = items.map(m => `
        <tr>
            <td>${m.title}</td>
            <td>${m.subject}</td>
            <td>${m.file_type || 'Document'}</td>
            <td>${m.file_size || 'N/A'}</td>
            <td>
                <button class="btn btn-danger btn-sm" onclick="deleteMaterial(${m.id})">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        </tr>
    `).join('');

    // admin-visible upload button (in content) so admins always have a way to upload
    const adminActions = (currentUserType === 'admin' || currentUserType === 'subadmin') ? `
        <div style="margin-bottom: 1rem;">
            <button class="btn btn-secondary" onclick="showFileUploadModal('materials')"><i class="fas fa-upload"></i> Upload File</button>
        </div>
    ` : '';

    return `
        <div class="content-card">
            <h3><i class="fas fa-folder-open"></i> Study Materials</h3>
            ${adminActions}
            <table class="data-table">
                <thead>
                    <tr><th>Title</th><th>Subject</th><th>Type</th><th>Size</th><th>Actions</th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

async function generateExamContent() {
    const data = await apiCall('/admin/get_exams');
    if (!data || !data.success) return `<div class="error-message">Failed to load exams</div>`;
    // newest-first by exam_date
    const exams = sortNewestFirst(Array.isArray(data.exams) ? data.exams.slice() : [], { dateField: 'exam_date' });

    const rows = exams.map(e => `
        <tr>
            <td>${e.subject}</td>
            <td>${e.exam_type}</td>
            <td>${e.exam_date}</td>
            <td>${e.total_marks}</td>
            <td>
                <button class="btn btn-danger btn-sm" onclick="deleteExam(${e.id})">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        </tr>
    `).join('');

    return `
        <div class="content-card">
            <h3><i class="fas fa-clipboard-list"></i> Scheduled Exams</h3>
            <table class="data-table">
                <thead>
                    <tr><th>Subject</th><th>Type</th><th>Date</th><th>Total Marks</th><th>Actions</th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

// ==================== Modal and Utility Functions ====================

// Modal functions
function showModal(title, content) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = content;
    document.getElementById('modal').classList.add('active');
}

function closeModal() {
    document.getElementById('modal').classList.remove('active');
}

function closeFileModal() {
    document.getElementById('fileModal').classList.remove('active');
}

// Utility functions
function showPage(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(pageId).classList.add('active');
}

// Generic helper: sort an array of records so newest items come first.
// Attempts to use `dateField` (default `created_at`), falls back to `id`, then to common date fields.
function sortNewestFirst(items, options = {}) {
    if (!Array.isArray(items)) return items;
    const dateField = options.dateField || 'created_at';
    try {
        items.sort((a, b) => {
            const av = a && a[dateField] ? Date.parse(a[dateField]) : null;
            const bv = b && b[dateField] ? Date.parse(b[dateField]) : null;
            if (av !== null && bv !== null) return bv - av;
            if (a && b && typeof a.id !== 'undefined' && typeof b.id !== 'undefined') return b.id - a.id;
            // try common alternate date fields
            const alt = ['due_date', 'exam_date', 'date'];
            for (const f of alt) {
                const aa = a && a[f] ? Date.parse(a[f]) : null;
                const bb = b && b[f] ? Date.parse(b[f]) : null;
                if (aa !== null && bb !== null) return bb - aa;
            }
            return 0;
        });
    } catch (err) {
        console.warn('sortNewestFirst failed:', err);
    }
    return items;
}

function showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
        color: white;
        padding: 1rem 1.5rem;
        border-radius: 0.5rem;
        box-shadow: 0 4px 15px rgba(0,0,0,0.15);
        z-index: 9999;
        max-width: 300px;
        font-weight: 500;
    `;
    notification.textContent = message;

    document.body.appendChild(notification);

    // Remove notification after 4 seconds
    setTimeout(() => {
        notification.remove();
    }, 4000);
}

function setupFileUpload() {
    // File upload setup will be implemented when needed
}

// Add placeholder functions for admin modals (simplified)
function showAddAssignmentModal() {
    const content = `
        <form onsubmit="addAssignment(event)">
            <div class="form-grid">
                <div class="form-group">
                    <label>Title</label>
                    <input type="text" id="assignmentTitle" required>
                </div>
                <div class="form-group">
                    <label>Subject</label>
                    <input type="text" id="assignmentSubject" required>
                </div>
                <div class="form-group">
                    <label>Description</label>
                    <textarea id="assignmentDescription" rows="3"></textarea>
                </div>
                <div class="form-group">
                    <label>Due Date</label>
                    <input type="date" id="assignmentDueDate" required>
                </div>
                <div class="form-group">
                    <label>Course</label>
                    <select id="assignmentCourse">
                        <option value="">-- All / Select Course --</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Semester</label>
                    <select id="assignmentSemester">
                        <option value="">-- Select Semester --</option>
                        <option value="1">Semester 1</option>
                        <option value="2">Semester 2</option>
                        <option value="3">Semester 3</option>
                        <option value="4">Semester 4</option>
                        <option value="5">Semester 5</option>
                        <option value="6">Semester 6</option>
                        <option value="7">Semester 7</option>
                        <option value="8">Semester 8</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Attach File (optional)</label>
                    <input type="file" id="assignmentFile" accept=".pdf,.doc,.docx">
                    <small class="form-hint">Allowed types: PDF, DOC, DOCX</small>
                </div>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button type="submit" class="btn btn-primary">Add Assignment</button>
            </div>
        </form>
    `;
    showModal('Add New Assignment', content);
    // populate course and semester dropdowns dynamically
    loadCourses().then(() => { updateSelectOptions('assignmentCourse', getCourses()); updateSemesterDropdown('assignmentSemester'); });
}

async function addAssignment(e) {
    e.preventDefault();
    const fileInput = document.getElementById('assignmentFile');
    const title = document.getElementById('assignmentTitle').value;
    const subject = document.getElementById('assignmentSubject').value;
    const description = document.getElementById('assignmentDescription').value;
    const due_date = document.getElementById('assignmentDueDate').value;

    // If a file is attached, use multipart upload endpoint
    if (fileInput && fileInput.files && fileInput.files[0]) {
        const allowed = ['pdf', 'doc', 'docx'];
        const fname = fileInput.files[0].name || '';
        const ext = fname.split('.').pop().toLowerCase();
        if (!allowed.includes(ext)) {
            showNotification('Only PDF, DOC, DOCX files are allowed.', 'error');
            return;
        }
        const formData = new FormData();
        formData.append('file', fileInput.files[0]);
        formData.append('title', title);
        formData.append('subject', subject);
        formData.append('description', description);
        formData.append('due_date', due_date);
        formData.append('uploaded_by', currentUser.id);
        formData.append('course', document.getElementById('assignmentCourse')?.value || '');
        formData.append('semester', normalizeSemester(document.getElementById('assignmentSemester')?.value || ''));

        try {
            const resp = await fetch('/api/admin/upload_assignment', {
                method: 'POST',
                body: formData,
                credentials: 'include'
            });
            const result = await resp.json();
            if (result && result.success) {
                closeModal();
                await showSection('assignments-admin');
                showNotification('Assignment uploaded successfully', 'success');
                return;
            } else {
                showNotification(result?.message || 'Failed to upload assignment', 'error');
                return;
            }
        } catch (err) {
            console.error('Upload assignment failed', err);
            showNotification('Upload failed. Please try again.', 'error');
            return;
        }
    }

    // No file: fallback to JSON endpoint
    const assignmentData = {
        title,
        subject,
        description,
        due_date,
        course: document.getElementById('assignmentCourse')?.value || '',
        semester: normalizeSemester(document.getElementById('assignmentSemester')?.value || ''),
        created_by: currentUser.id
    };

    const result = await apiCall('/admin/add_assignment', 'POST', assignmentData);
    if (result && result.success) {
        closeModal();
        await showSection('assignments-admin');
        showNotification('Assignment added successfully', 'success');
    } else {
        showNotification(result?.message || 'Failed to add assignment', 'error');
    }
}

function showAddAttendanceModal() {
    const content = `
        <form onsubmit="addAttendance(event)">
            <div class="form-grid">
                <div class="form-group">
                    <label>Student ID</label>
                    <input type="number" id="attendanceStudentId" required>
                </div>
                <div class="form-group">
                    <label>Subject</label>
                    <input type="text" id="attendanceSubject" required>
                </div>
                <div class="form-group">
                    <label>Date</label>
                    <input type="date" id="attendanceDate" required>
                </div>
                <div class="form-group">
                    <label>Status</label>
                    <select id="attendanceStatus" required>
                        <option value="">Select Status</option>
                        <option value="present">Present</option>
                        <option value="absent">Absent</option>
                        <option value="late">Late</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Course</label>
                    <select id="attendanceCourse"></select>
                </div>
                <div class="form-group">
                    <label>Semester</label>
                    <select id="attendanceSemester">
                        <option value="">-- Select Semester --</option>
                        <option value="1">Semester 1</option>
                        <option value="2">Semester 2</option>
                        <option value="3">Semester 3</option>
                        <option value="4">Semester 4</option>
                        <option value="5">Semester 5</option>
                        <option value="6">Semester 6</option>
                        <option value="7">Semester 7</option>
                        <option value="8">Semester 8</option>
                    </select>
                </div>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button type="submit" class="btn btn-primary">Add Attendance</button>
            </div>
        </form>
    `;
    showModal('Add Attendance Record', content);
    loadCourses().then(() => { updateSelectOptions('attendanceCourse', getCourses()); updateSemesterDropdown('attendanceSemester'); });
}

async function addAttendance(e) {
    e.preventDefault();
    const attendanceData = {
        student_id: parseInt(document.getElementById('attendanceStudentId').value),
        subject: document.getElementById('attendanceSubject').value,
        date: document.getElementById('attendanceDate').value,
        status: document.getElementById('attendanceStatus').value,
        course: document.getElementById('attendanceCourse')?.value || '',
        semester: normalizeSemester(document.getElementById('attendanceSemester')?.value || '')
    };

    const result = await apiCall('/admin/add_attendance', 'POST', attendanceData);
    if (result && result.success) {
        closeModal();
        await showSection('attendance-admin');
        showNotification('Attendance record added successfully', 'success');
    } else {
        showNotification(result?.message || 'Failed to add attendance', 'error');
    }
}

function showAddMarkModal() {
    const content = `
        <form onsubmit="addMark(event)">
            <div class="form-grid">
                <div class="form-group">
                    <label>Student ID</label>
                    <input type="number" id="markStudentId" required>
                </div>
                <div class="form-group">
                    <label>Subject</label>
                    <input type="text" id="markSubject" required>
                </div>
                <div class="form-group">
                    <label>Exam Type</label>
                    <input type="text" id="markExamType">
                </div>
                <div class="form-group">
                    <label>Marks Obtained</label>
                    <input type="number" id="markObtained" required>
                </div>
                <div class="form-group">
                    <label>Total Marks</label>
                    <input type="number" id="markTotal" required>
                </div>
                <div class="form-group">
                    <label>Grade</label>
                    <input type="text" id="markGrade">
                </div>
                <div class="form-group">
                    <label>Exam Date</label>
                    <input type="date" id="markExamDate">
                </div>
                <div class="form-group">
                    <label>Course</label>
                    <select id="markCourse"></select>
                </div>
                <div class="form-group">
                    <label>Semester</label>
                    <select id="markSemester">
                        <option value="">-- Select Semester --</option>
                        <option value="1">Semester 1</option>
                        <option value="2">Semester 2</option>
                        <option value="3">Semester 3</option>
                        <option value="4">Semester 4</option>
                        <option value="5">Semester 5</option>
                        <option value="6">Semester 6</option>
                        <option value="7">Semester 7</option>
                        <option value="8">Semester 8</option>
                    </select>
                </div>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button type="submit" class="btn btn-primary">Add Mark</button>
            </div>
        </form>
    `;
    showModal('Add Mark', content);
    loadCourses().then(() => { updateSelectOptions('markCourse', getCourses()); updateSemesterDropdown('markSemester'); });
}

async function addMark(e) {
    e.preventDefault();
    const markData = {
        student_id: parseInt(document.getElementById('markStudentId').value),
        subject: document.getElementById('markSubject').value,
        exam_type: document.getElementById('markExamType').value,
        marks_obtained: parseFloat(document.getElementById('markObtained').value),
        total_marks: parseFloat(document.getElementById('markTotal').value),
        grade: document.getElementById('markGrade').value,
        exam_date: document.getElementById('markExamDate').value,
        course: document.getElementById('markCourse')?.value || '',
        semester: normalizeSemester(document.getElementById('markSemester')?.value || '')
    };

    const result = await apiCall('/admin/add_mark', 'POST', markData);
    if (result && result.success) {
        closeModal();
        await showSection('marks-admin');
        showNotification('Mark added successfully', 'success');
    } else {
        showNotification(result?.message || 'Failed to add mark', 'error');
    }
}

function showAddAnnouncementModal() {
    const content = `
        <form onsubmit="addAnnouncement(event)">
            <div class="form-grid">
                <div class="form-group">
                    <label>Title</label>
                    <input type="text" id="announcementTitle" required>
                </div>
                <div class="form-group">
                    <label>Content</label>
                    <textarea id="announcementContent" rows="4" required></textarea>
                </div>
                <div class="form-group">
                    <label>Priority</label>
                    <select id="announcementPriority" required>
                        <option value="">Select Priority</option>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Course (optional)</label>
                    <select id="announcementCourse">
                        <option value="">-- All / Select Course --</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Semester (optional)</label>
                    <select id="announcementSemester">
                        <option value="">-- All Semesters --</option>
                        <option value="1">Semester 1</option>
                        <option value="2">Semester 2</option>
                        <option value="3">Semester 3</option>
                        <option value="4">Semester 4</option>
                        <option value="5">Semester 5</option>
                        <option value="6">Semester 6</option>
                        <option value="7">Semester 7</option>
                        <option value="8">Semester 8</option>
                    </select>
                </div>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button type="submit" class="btn btn-primary">Add Announcement</button>
            </div>
        </form>
    `;
    showModal('Add New Announcement', content);
    loadCourses().then(() => { updateSelectOptions('announcementCourse', getCourses()); updateSemesterDropdown('announcementSemester'); });
}

async function addAnnouncement(e) {
    e.preventDefault();
    const announcementData = {
        title: document.getElementById('announcementTitle').value,
        content: document.getElementById('announcementContent').value,
        priority: document.getElementById('announcementPriority').value,
        created_by: currentUser.id
    };
    announcementData.course = document.getElementById('announcementCourse')?.value || '';
    announcementData.semester = normalizeSemester(document.getElementById('announcementSemester')?.value || '');
    const result = await apiCall('/admin/add_announcement', 'POST', announcementData);
    if (result && result.success) {
        closeModal();
        await showSection('announcements-admin');
        showNotification('Announcement deleted successfully', 'success');
    } else {
        showNotification(result?.message || 'Failed to add announcement', 'error');
    }
}

function showAddExamModal() {
    const content = `
        <form onsubmit="addExam(event)">
            <div class="form-grid">
                <div class="form-group">
                    <label>Subject</label>
                    <input type="text" id="examSubject" required>
                </div>
                <div class="form-group">
                    <label>Exam Type</label>
                    <select id="examType" required>
                        <option value="">Select Type</option>
                        <option value="Mid-term">Mid-term</option>
                        <option value="Final">Final</option>
                        <option value="Quiz">Quiz</option>
                        <option value="Assignment">Assignment</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Exam Date</label>
                    <input type="date" id="examDate" required>
                </div>
                <div class="form-group">
                    <label>Total Marks</label>
                    <input type="number" id="examTotalMarks" required>
                </div>
                <div class="form-group">
                    <label>Description</label>
                    <textarea id="examDescription" rows="3"></textarea>
                </div>
                <div class="form-group">
                    <label>Course</label>
                    <select id="examCourse"></select>
                </div>
                <div class="form-group">
                    <label>Semester</label>
                    <select id="examSemester">
                        <option value="">-- Select Semester --</option>
                        <option value="1">Semester 1</option>
                        <option value="2">Semester 2</option>
                        <option value="3">Semester 3</option>
                        <option value="4">Semester 4</option>
                        <option value="5">Semester 5</option>
                        <option value="6">Semester 6</option>
                        <option value="7">Semester 7</option>
                        <option value="8">Semester 8</option>
                    </select>
                </div>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button type="submit" class="btn btn-primary">Add Exam</button>
            </div>
        </form>
    `;
    showModal('Add New Exam', content);
    loadCourses().then(() => { updateSelectOptions('examCourse', getCourses()); updateSemesterDropdown('examSemester'); });
}

async function addExam(e) {
    e.preventDefault();
    const examData = {
        subject: document.getElementById('examSubject').value,
        exam_type: document.getElementById('examType').value,
        exam_date: document.getElementById('examDate').value,
        total_marks: parseInt(document.getElementById('examTotalMarks').value),
        description: document.getElementById('examDescription').value,
        course: document.getElementById('examCourse')?.value || '',
        semester: normalizeSemester(document.getElementById('examSemester')?.value || '')
    };

    const result = await apiCall('/admin/add_exam', 'POST', examData);
    if (result && result.success) {
        closeModal();
        await showSection('exam-admin');
        showNotification('Exam added successfully', 'success');
    } else {
        showNotification(result?.message || 'Failed to add exam', 'error');
    }
}

function showAddMaterialModal() {
    const content = `
        <form onsubmit="addMaterial(event)">
            <div class="form-grid">
                <div class="form-group">
                    <label>Title</label>
                    <input type="text" id="materialTitle" required>
                </div>
                <div class="form-group">
                    <label>Subject</label>
                    <input type="text" id="materialSubject" required>
                </div>
                <div class="form-group">
                    <label>Attach File (optional)</label>
                    <input type="file" id="materialFile" accept=".pdf,.doc,.docx,.ppt,.pptx">
                    <small class="form-hint">Allowed: PDF, DOC, DOCX, PPT</small>
                </div>
                <div class="form-group">
                    <label>Course</label>
                    <select id="materialCourse"></select>
                </div>
                <div class="form-group">
                    <label>Semester</label>
                    <select id="materialSemester">
                        <option value="">-- Select Semester --</option>
                        <option value="1">Semester 1</option>
                        <option value="2">Semester 2</option>
                        <option value="3">Semester 3</option>
                        <option value="4">Semester 4</option>
                        <option value="5">Semester 5</option>
                        <option value="6">Semester 6</option>
                        <option value="7">Semester 7</option>
                        <option value="8">Semester 8</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Description</label>
                    <textarea id="materialDescription" rows="3"></textarea>
                </div>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button type="submit" class="btn btn-primary">Add Material</button>
            </div>
        </form>
    `;
    showModal('Add Study Material', content);
    loadCourses().then(() => { updateSelectOptions('materialCourse', getCourses()); updateSemesterDropdown('materialSemester'); });
}

async function addMaterial(e) {
    e.preventDefault();
    const fileInput = document.getElementById('materialFile');
    const title = document.getElementById('materialTitle').value;
    const subject = document.getElementById('materialSubject').value;
    const description = document.getElementById('materialDescription').value;

    if (fileInput && fileInput.files && fileInput.files[0]) {
        const fname = fileInput.files[0].name || '';
        const ext = fname.split('.').pop().toLowerCase();
        const allowed = ['pdf', 'doc', 'docx', 'ppt', 'pptx'];
        if (!allowed.includes(ext)) {
            showNotification('Invalid file type. Allowed: PDF, DOC, DOCX, PPT', 'error');
            return;
        }

        const formData = new FormData();
        formData.append('file', fileInput.files[0]);
        formData.append('title', title);
        formData.append('subject', subject);
        formData.append('description', description);
        formData.append('uploaded_by', currentUser.id);
        formData.append('course', document.getElementById('materialCourse')?.value || '');
        formData.append('semester', normalizeSemester(document.getElementById('materialSemester')?.value || ''));

        try {
            const resp = await fetch('/api/admin/upload_material', {
                method: 'POST',
                body: formData,
                credentials: 'include'
            });
            const result = await resp.json();
            if (result && result.success) {
                closeModal();
                await showSection('materials-admin');
                showNotification('Material uploaded successfully', 'success');
                return;
            } else {
                showNotification(result?.message || 'Failed to upload material', 'error');
                return;
            }
        } catch (err) {
            console.error('Upload material failed', err);
            showNotification('Upload failed. Please try again.', 'error');
            return;
        }
    }

    // No file: fallback to JSON endpoint
    const materialData = {
        title,
        subject,
        file_type: 'Other',
        file_path: '',
        description,
        uploaded_by: currentUser.id
    };
    materialData.course = document.getElementById('materialCourse')?.value || '';
    materialData.semester = normalizeSemester(document.getElementById('materialSemester')?.value || '');

    const result = await apiCall('/admin/add_material', 'POST', materialData);
    if (result && result.success) {
        closeModal();
        await showSection('materials-admin');
        showNotification('Material added successfully', 'success');
    } else {
        showNotification(result?.message || 'Failed to add material', 'error');
    }
}

// ==================== Delete Functions ====================

async function deleteAssignment(id) {
    if (!confirm('Are you sure you want to delete this assignment?')) return;

    const result = await apiCall(`/admin/delete_assignment/${id}`, 'DELETE');
    if (result && result.success) {
        await showSection('assignments-admin');
        showNotification('Assignment deleted successfully', 'success');
    } else {
        showNotification('Failed to delete assignment', 'error');
    }
}

async function deleteAttendance(id) {
    if (!confirm('Are you sure you want to delete this attendance record?')) return;

    const result = await apiCall(`/admin/delete_attendance/${id}`, 'DELETE');
    if (result && result.success) {
        await showSection('attendance-admin');
        showNotification('Attendance record deleted successfully', 'success');
    } else {
        showNotification('Failed to delete attendance record', 'error');
    }
}

async function deleteMark(id) {
    if (!confirm('Are you sure you want to delete this mark record?')) return;

    const result = await apiCall(`/admin/delete_mark/${id}`, 'DELETE');
    if (result && result.success) {
        await showSection('marks-admin');
        showNotification('Mark record deleted successfully', 'success');
    } else {
        showNotification('Failed to delete mark record', 'error');
    }
}

async function deleteAnnouncement(id) {
    if (!confirm('Are you sure you want to delete this announcement?')) return;

    const result = await apiCall(`/admin/delete_announcement/${id}`, 'DELETE');
    if (result && result.success) {
        await showSection('announcements-admin');
        showNotification('Announcement deleted successfully', 'success');
    } else {
        showNotification('Failed to delete announcement', 'error');
    }
}

async function deleteMaterial(id) {
    if (!confirm('Are you sure you want to delete this material?')) return;

    const result = await apiCall(`/admin/delete_material/${id}`, 'DELETE');
    if (result && result.success) {
        await showSection('materials-admin');
        showNotification('Material deleted successfully', 'success');
    } else {
        showNotification('Failed to delete material', 'error');
    }
}


// ==================== Edit User Function ====================

async function editUser(id) {
    // First, get user details
    const users = await apiCall('/admin/get_users');
    if (!users || !users.success) {
        showNotification('Failed to load user details', 'error');
        return;
    }

    const user = users.users.find(u => u.id === id);
    if (!user) {
        showNotification('User not found', 'error');
        return;
    }

    const content = `
        <form onsubmit="updateUser(event, ${id})">
            <div class="form-grid">
                <div class="form-group">
                    <label>Username</label>
                    <input type="text" id="editUsername" value="${user.username}" required>
                </div>
                <div class="form-group">
                    <label>Password (leave empty to keep current)</label>
                    <input type="password" id="editPassword" placeholder="Enter new password">
                </div>
                <div class="form-group">
                    <label>Full Name</label>
                    <input type="text" id="editName" value="${user.name}" required>
                </div>
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" id="editEmail" value="${user.email}" required>
                </div>
                <div class="form-group">
                    <label>User Type</label>
                    <select id="editUserType" required onchange="toggleEditStudentFields()">
                        <option value="student" ${user.user_type === 'student' ? 'selected' : ''}>Student</option>
                        <option value="admin" ${user.user_type === 'admin' ? 'selected' : ''}>Admin</option>
                        <option value="subadmin" ${user.user_type === 'subadmin' ? 'selected' : ''}>Sub-Admin</option>
                    </select>
                </div>
                <div id="editStudentFields" style="display: ${user.user_type === 'student' ? 'block' : 'none'};">
                    <div class="form-group">
                        <label>Roll Number</label>
                        <input type="text" id="editRollNumber" value="${user.roll_number || ''}">
                    </div>
                    <div class="form-group">
                        <label>Course</label>
                        <select id="editCourse"></select>
                    </div>
                    <div class="form-group">
                        <label>Semester</label>
                        <select id="editSemester"></select>
                    </div>
                    <div class="form-group">
                        <label>Phone</label>
                        <input type="text" id="editPhone" value="${user.phone || ''}">
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button type="submit" class="btn btn-primary">Update User</button>
            </div>
        </form>
    `;
    showModal('Edit User', content);

    // // // Attach event listener to user type select to toggle student fields
    document.getElementById('editUserType').addEventListener('change', toggleEditStudentFields);
    // Populate dynamic selects for edit user (only if student fields are visible)
    loadCourses().then(() => {
        updateSelectOptions('editCourse', getCourses());
        // select current values
        try { document.getElementById('editCourse').value = user.course || ''; } catch (e) { }
        updateSemesterDropdown('editSemester');
        try { document.getElementById('editSemester').value = semesterToNumber(user.semester || ''); } catch (e) { }
    });
}

function toggleEditStudentFields() {
    const userType = document.getElementById('editUserType').value;
    const studentFields = document.getElementById('editStudentFields');
    if (userType === 'student') {
        studentFields.style.display = 'block';
    } else {
        studentFields.style.display = 'none';
    }
}

async function updateUser(e, id) {
    e.preventDefault();
    const userData = {
        username: document.getElementById('editUsername').value,
        name: document.getElementById('editName').value,
        email: document.getElementById('editEmail').value,
        user_type: document.getElementById('editUserType').value
    };

    const password = document.getElementById('editPassword').value;
    if (password) {
        userData.password = password;
    }

    // Add student-specific fields if user type is student
    if (userData.user_type === 'student') {
        userData.roll_number = document.getElementById('editRollNumber').value;
        userData.course = document.getElementById('editCourse').value;
        userData.semester = normalizeSemester(document.getElementById('editSemester').value);
        userData.phone = document.getElementById('editPhone').value;
    }

    const result = await apiCall(`/admin/update_user/${id}`, 'PUT', userData);
    if (result && result.success) {
        closeModal();
        await loadUsers();
        showNotification('User updated successfully', 'success');
    } else {
        showNotification(result?.message || 'Failed to update user', 'error');
    }
}

// ==================== File Upload Modal ====================

function showFileUploadModal(type) {
    let extraFields = '';
    if (type === 'materials') {
        extraFields = `
            <div class="form-group">
                <label>Course Type</label>
                <select id="fileCourse"></select>
            </div>
            <div class="form-group">
                <label>Semester Type</label>
                <select id="fileSemester">
                    <option value="">-- Select Semester --</option>
                    <option value="1">Semester 1</option>
                    <option value="2">Semester 2</option>
                    <option value="3">Semester 3</option>
                    <option value="4">Semester 4</option>
                    <option value="5">Semester 5</option>
                    <option value="6">Semester 6</option>
                    <option value="7">Semester 7</option>
                    <option value="8">Semester 8</option>
                </select>
            </div>
        `;
    }

    const content = `
        <form id="fileUploadForm" onsubmit="uploadFile(event, '${type}')">
            <div class="form-group">
                <label>Select File</label>
                <input type="file" id="fileInput" required>
            </div>
            <div class="form-group">
                <label>Title</label>
                <input type="text" id="fileTitle" required>
            </div>
            ${extraFields}
            <div class="form-group">
                <label>Description</label>
                <textarea id="fileDescription" rows="2"></textarea>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button type="submit" class="btn btn-primary">Upload</button>
            </div>
        </form>
    `;
    showModal('Upload ' + (type === 'materials' ? 'Material' : 'Assignment'), content);

    if (type === 'materials') {
        loadCourses().then(() => {
            updateSelectOptions('fileCourse', getCourses());
            updateSemesterDropdown('fileSemester');
        });
    }
}

async function uploadFile(e, type) {
    e.preventDefault();
    const fileInput = document.getElementById('fileInput');
    const title = document.getElementById('fileTitle').value;
    const description = document.getElementById('fileDescription').value;

    if (!fileInput.files[0]) {
        showNotification('Please select a file to upload', 'error');
        return;
    }

    // Client-side file type validation
    const filename = fileInput.files[0].name || '';
    const ext = filename.split('.').pop().toLowerCase();

    if (type === 'assignments') {
        const allowedExt = ['pdf', 'doc', 'docx'];
        if (!allowedExt.includes(ext)) {
            showNotification('Only PDF, DOC, and DOCX files are allowed for assignments.', 'error');
            return;
        }
    } else if (type === 'materials') {
        const allowedExt = ['pdf', 'doc', 'docx', 'ppt', 'pptx'];
        if (!allowedExt.includes(ext)) {
            showNotification('Only PDF, DOC, DOCX, and PPT files are allowed for materials.', 'error');
            return;
        }
    }

    const formData = new FormData();
    formData.append('file', fileInput.files[0]);
    formData.append('title', title);
    formData.append('description', description);
    formData.append('uploaded_by', currentUser.id);

    if (type === 'materials') {
        formData.append('course', document.getElementById('fileCourse')?.value || '');
        formData.append('semester', normalizeSemester(document.getElementById('fileSemester')?.value || ''));
    }

    const url = type === 'materials' ? '/api/admin/upload_material' : '/api/admin/upload_assignment';

    try {
        const response = await fetch(url, {
            method: 'POST',
            body: formData,
            credentials: 'include'
        });
        const result = await response.json();
        if (result && result.success) {
            closeModal();
            await showSection(type + '-admin');
            showNotification(type === 'materials' ? 'Material uploaded successfully' : 'Assignment uploaded successfully', 'success');
        } else {
            showNotification(result?.message || 'Failed to upload file', 'error');
        }
    } catch (error) {
        console.error('Upload failed', error);
        showNotification('Upload failed. Please try again.', 'error');
    }
}


// ==================== Bulk Add Modal and Logic ====================

function showBulkAddModal(type) {
    let title = '';
    let hint = '';
    let templateFn = '';
    let extraFields = '';

    if (type === 'attendance' || type === 'marks') {
        extraFields = `
            <div class="form-group">
                <label>Course Type</label>
                <select id="bulkCourse"></select>
            </div>
            <div class="form-group">
                <label>Semester Type</label>
                <select id="bulkSemester">
                    <option value="">-- Select Semester --</option>
                    <option value="1">Semester 1</option>
                    <option value="2">Semester 2</option>
                    <option value="3">Semester 3</option>
                    <option value="4">Semester 4</option>
                    <option value="5">Semester 5</option>
                    <option value="6">Semester 6</option>
                    <option value="7">Semester 7</option>
                    <option value="8">Semester 8</option>
                </select>
            </div>
        `;
    }

    switch (type) {
        case 'users':
            title = 'Bulk Add Users';
            hint = 'Required columns: username, password, name, email, user_type. Optional: roll_number, course, semester, phone.';
            templateFn = 'downloadUserTemplate()';
            break;
        case 'attendance':
            title = 'Bulk Add Attendance';
            hint = 'Required columns: roll_number, subject, date, status (present/absent/late). Course and Semester can be selected below.';
            templateFn = 'downloadAttendanceTemplate()';
            break;
        case 'marks':
            title = 'Bulk Add Marks';
            hint = 'Required columns: roll_number, subject, marks_obtained. Optional: total_marks, grade, exam_type, exam_date. Course and Semester can be selected below.';
            templateFn = 'downloadMarksTemplate()';
            break;
    }

    const content = `
        <form onsubmit="handleBulkUpload(event, '${type}')">
            <div class="form-group">
                <label>Select Excel/CSV File</label>
                <input type="file" id="bulkFileInput" accept=".xlsx,.xls,.csv" required>
                <small class="form-hint">${hint}</small>
            </div>
            ${extraFields}
            <div class="form-group">
                <label>Description (optional)</label>
                <textarea id="bulkDescription" rows="2"></textarea>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button type="button" class="btn btn-outline" onclick="${templateFn}">Download Template</button>
                <button type="submit" class="btn btn-primary">Upload</button>
            </div>
        </form>
    `;
    showModal(title, content);

    if (type === 'attendance' || type === 'marks') {
        loadCourses().then(() => {
            updateSelectOptions('bulkCourse', getCourses());
            updateSemesterDropdown('bulkSemester');
        });
    }
}

async function handleBulkUpload(e, type) {
    e.preventDefault();
    const fileInput = document.getElementById('bulkFileInput');
    const description = document.getElementById('bulkDescription').value;

    if (!fileInput.files[0]) {
        showNotification('Please select a file to upload', 'error');
        return;
    }

    const formData = new FormData();
    formData.append('file', fileInput.files[0]);
    formData.append('description', description);
    formData.append('uploaded_by', currentUser.id);

    if (type === 'attendance' || type === 'marks') {
        const course = document.getElementById('bulkCourse')?.value;
        const semester = normalizeSemester(document.getElementById('bulkSemester')?.value || '');
        if (course) formData.append('course', course);
        if (semester) formData.append('semester', semester);
    }

    const endpoint = `/api/admin/bulk_add_${type}`;

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            body: formData,
            credentials: 'include'
        });

        const result = await response.json();
        if (result && result.success) {
            closeModal();
            showNotification(result.message || 'Bulk upload successful', 'success');
            // Refresh the current section
            showSection(currentSection);
        } else {
            showNotification(result?.message || 'Bulk upload failed', 'error');
        }
    } catch (error) {
        console.error('Bulk upload error:', error);
        showNotification('Upload failed. Please check your connection and try again.', 'error');
    }
}

function downloadUserTemplate() {
    const csvContent = "username,password,name,email,user_type,roll_number,course,semester,phone\nstudent2,pass123,Jane Doe,jane@edu.com,student,CSE2023002,BT,1\nstaff1,pass123,Staff Member,staff@edu.com,admin,,,";
    downloadCSV('users_template.csv', csvContent);
}

function downloadAttendanceTemplate() {
    const csvContent = "roll_number,subject,date,status\nCSE2023001,Mathematics,2025-01-20,present\nCSE2023001,Physics,2025-01-20,absent";
    downloadCSV('attendance_template.csv', csvContent);
}

function downloadMarksTemplate() {
    const csvContent = "roll_number,subject,marks_obtained,total_marks,exam_type,grade,exam_date\nCSE2023001,Mathematics,85,100,Midterm,A,2025-01-15\nCSE2023001,Physics,72,100,Midterm,B,2025-01-16";
    downloadCSV('marks_template.csv', csvContent);
}

function downloadCSV(filename, content) {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function downloadTableAsCSV(tableSelector, filename) {
    const table = document.querySelector(tableSelector);
    if (!table) return;

    let csvContent = [];
    const rows = table.querySelectorAll('tr');

    rows.forEach(row => {
        let cols = row.querySelectorAll('th, td');
        let rowData = [];
        // Skip the very last column if it contains "Actions" buttons
        const isHeader = row.querySelector('th') !== null;
        let colCount = cols.length;
        if (!isHeader && cols[colCount-1].querySelector('button')) {
            colCount--; 
        } else if (isHeader && cols[colCount-1].innerText.trim() === 'Actions') {
            colCount--;
        }

        for (let i = 0; i < colCount; i++) {
            // Get text, escape quotes
            let text = cols[i].innerText.trim().replace(/"/g, '""');
            // Quote the text if it contains comma, newline, or double quote
            if (text.includes(',') || text.includes('\\n') || text.includes('"')) {
                text = '"' + text + '"';
            }
            rowData.push(text);
        }
        csvContent.push(rowData.join(','));
    });

    downloadCSV(filename, csvContent.join('\\n'));
}

// =====================================================================
//  FEATURE 7: Notification Bell
// =====================================================================
let notifPanelOpen = false;

async function loadNotifBell() {
    try {
        const data = await apiCall('/student/unread_announcements_count');
        const badge = document.getElementById('notifBadge');
        if (badge && data && data.success) {
            if (data.count > 0) {
                badge.textContent = data.count > 99 ? '99+' : data.count;
                badge.style.display = 'flex';
            } else {
                badge.style.display = 'none';
            }
        }
    } catch (e) { console.warn('notif bell load failed', e); }
}

function toggleNotifPanel() {
    const panel = document.getElementById('notifPanel');
    if (!panel) return;
    notifPanelOpen = !notifPanelOpen;
    panel.style.display = notifPanelOpen ? 'block' : 'none';
    if (notifPanelOpen) loadNotifPanelContent();
}

async function loadNotifPanelContent() {
    const body = document.getElementById('notifPanelBody');
    if (!body) return;
    body.innerHTML = '<p style="padding:1rem; color:#64748b; text-align:center;"><i class="fas fa-spinner fa-spin"></i> Loading...</p>';
    try {
        const data = await apiCall('/student/announcements');
        if (!data || !data.success || !data.announcements.length) {
            body.innerHTML = '<p style="padding:1rem; color:#64748b; text-align:center;">No recent announcements</p>';
            return;
        }
        const items = data.announcements.slice(0, 5).map(a => {
            const d = new Date(a.created_at);
            const timeAgo = formatTimeAgo(d);
            return `
                <div class="notif-item notif-priority-${a.priority || 'medium'}" onclick="toggleNotifPanel(); showSection('announcements-student');">
                    <div class="notif-title">${escapeHtml(a.title)}</div>
                    <div class="notif-time">${timeAgo}</div>
                </div>`;
        }).join('');
        body.innerHTML = items;
    } catch (e) {
        body.innerHTML = '<p style="padding:1rem; color:#ef4444; text-align:center;">Failed to load</p>';
    }
}

function formatTimeAgo(date) {
    const diff = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
    return `${Math.floor(diff/86400)}d ago`;
}

// Close notif panel when clicking outside
document.addEventListener('click', (e) => {
    const wrap = document.getElementById('notifBellWrap');
    if (notifPanelOpen && wrap && !wrap.contains(e.target)) {
        notifPanelOpen = false;
        const panel = document.getElementById('notifPanel');
        if (panel) panel.style.display = 'none';
    }
});

// =====================================================================
//  FEATURES 1, 2, 3: Student Dashboard Stats + Warning + Grade Calc
//  (These replace generateDashboardContent for students)
// =====================================================================
async function generateStudentDashboardContent() {
    let statsHtml = '';
    let warningHtml = '';

    try {
        const data = await apiCall(`/student/dashboard_stats/${currentUser.id}`);
        if (data && data.success) {
            const s = data.stats;
            const attClass = s.attendance_pct < 75 ? 'warning' : '';
            const attColor = s.attendance_pct < 75 ? '#ef4444' : (s.attendance_pct < 85 ? '#f59e0b' : '#22c55e');

            statsHtml = `
                <div class="stat-cards-grid">
                    <div class="stat-card attendance">
                        <div class="stat-icon"><i class="fas fa-calendar-check"></i></div>
                        <div class="stat-info">
                            <h4>Attendance</h4>
                            <div class="stat-value ${attClass}" style="${s.attendance_pct < 75 ? '' : `color:${attColor}`}">${s.attendance_pct}%</div>
                            <div class="stat-sub">${s.total_attendance} sessions recorded</div>
                        </div>
                    </div>
                    <div class="stat-card marks">
                        <div class="stat-icon"><i class="fas fa-chart-line"></i></div>
                        <div class="stat-info">
                            <h4>Average Score</h4>
                            <div class="stat-value">${s.avg_marks_pct}%</div>
                            <div class="stat-sub">Overall performance</div>
                        </div>
                    </div>
                    <div class="stat-card assignments">
                        <div class="stat-icon"><i class="fas fa-tasks"></i></div>
                        <div class="stat-info">
                            <h4>Pending Assignments</h4>
                            <div class="stat-value ${s.pending_assignments > 0 ? 'warning' : ''}">${s.pending_assignments}</div>
                            <div class="stat-sub">Not yet submitted</div>
                        </div>
                    </div>
                    <div class="stat-card announcements">
                        <div class="stat-icon"><i class="fas fa-bullhorn"></i></div>
                        <div class="stat-info">
                            <h4>New Announcements</h4>
                            <div class="stat-value">${s.new_announcements}</div>
                            <div class="stat-sub">Last 7 days</div>
                        </div>
                    </div>
                </div>`;

            // Feature 2: Low Attendance Warning
            if (s.low_attendance) {
                warningHtml = `
                    <div class="attendance-warning-banner">
                        <i class="fas fa-exclamation-triangle"></i>
                        <div>
                            <p>⚠️ Low Attendance Alert!</p>
                            <span>Your overall attendance is ${s.attendance_pct}%, which is below the required 75%. Please attend more classes to avoid issues.</span>
                        </div>
                    </div>`;
            }
        }
    } catch (e) { console.warn('dashboard stats failed', e); }

    return `
        ${warningHtml}
        ${statsHtml}
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem;">
            <div class="content-card">
                <h3><i class="fas fa-user-circle"></i> My Info</h3>
                <p><strong>Name:</strong> ${escapeHtml(currentUser.name)}</p>
                <p style="margin-top:0.5rem"><strong>Roll No:</strong> ${escapeHtml(currentUser.roll_number || 'N/A')}</p>
                <p style="margin-top:0.5rem"><strong>Course:</strong> ${escapeHtml(currentUser.course || 'N/A')}</p>
                <p style="margin-top:0.5rem"><strong>Semester:</strong> ${escapeHtml(currentUser.semester || 'N/A')}</p>
            </div>
            <div class="content-card">
                <h3><i class="fas fa-bolt"></i> Quick Links</h3>
                <div style="display: flex; flex-direction: column; gap: 0.6rem; margin-top: 0.5rem;">
                    <a href="#" onclick="showSection('attendance-student')" class="btn btn-primary" style="text-decoration:none;"><i class="fas fa-calendar-check"></i> My Attendance</a>
                    <a href="#" onclick="showSection('marks-student')" class="btn btn-success" style="text-decoration:none;"><i class="fas fa-chart-line"></i> My Marks & Grades</a>
                    <a href="#" onclick="showSection('assignments-student')" class="btn btn-warning" style="text-decoration:none;"><i class="fas fa-tasks"></i> Assignments</a>
                    <a href="#" onclick="showSection('announcements-student')" class="btn btn-secondary" style="text-decoration:none;"><i class="fas fa-bullhorn"></i> Announcements</a>
                </div>
            </div>
        </div>`;
}

// =====================================================================
//  FEATURE 3: Grade Calculator (injected into student marks page)
// =====================================================================
function buildGradeCalculator(marksData) {
    if (!marksData || marksData.length === 0) return '';
    const scored = marksData.reduce((s, m) => s + (parseFloat(m.marks_obtained) || 0), 0);
    const total  = marksData.reduce((s, m) => s + (parseFloat(m.total_marks) || 100), 0);
    const pct = total > 0 ? (scored / total * 100).toFixed(1) : 0;

    // Simple CGPA on 10 scale (pct/10)
    const cgpa = (pct / 10).toFixed(2);

    // Grade classification
    let grade = 'F';
    if (pct >= 90) grade = 'O (Outstanding)';
    else if (pct >= 80) grade = 'A+ (Excellent)';
    else if (pct >= 70) grade = 'A (Very Good)';
    else if (pct >= 60) grade = 'B+ (Good)';
    else if (pct >= 50) grade = 'B (Average)';
    else if (pct >= 40) grade = 'C (Pass)';
    else grade = 'F (Fail)';

    return `
        <div class="grade-calc-card">
            <h4><i class="fas fa-calculator"></i> Grade Calculator</h4>
            <div class="grade-result-grid">
                <div class="grade-result-item">
                    <div class="g-value">${pct}%</div>
                    <div class="g-label">Overall Percentage</div>
                </div>
                <div class="grade-result-item">
                    <div class="g-value">${cgpa}</div>
                    <div class="g-label">CGPA (10-point scale)</div>
                </div>
                <div class="grade-result-item">
                    <div class="g-value" style="font-size:1.1rem;">${grade}</div>
                    <div class="g-label">Grade</div>
                </div>
                <div class="grade-result-item">
                    <div class="g-value">${marksData.length}</div>
                    <div class="g-label">Subjects Evaluated</div>
                </div>
            </div>
        </div>`;
}

// =====================================================================
//  FEATURES 8, 9: Profile Edit + Password Change
// =====================================================================
function generateProfileContent() {
    const isStudent = currentUserType === 'student';
    return `
        <div class="content-card">
            <div class="profile-header">
                <div class="profile-avatar"><i class="fas fa-user"></i></div>
                <div>
                    <h3>${escapeHtml(currentUser.name)}</h3>
                    <p style="color:#64748b; margin:0.4rem 0;">${currentUserType.charAt(0).toUpperCase() + currentUserType.slice(1)}</p>
                    <p style="color:#64748b; margin:0;"><i class="fas fa-envelope"></i> ${escapeHtml(currentUser.email)}</p>
                </div>
            </div>

            <!-- Edit Profile -->
            <div class="profile-section-title"><i class="fas fa-edit"></i> Edit Profile</div>
            <form id="profileEditForm" onsubmit="saveProfile(event)">
                <div class="profile-edit-grid">
                    <div class="form-group">
                        <label>Full Name</label>
                        <input type="text" id="editName" value="${escapeHtml(currentUser.name)}" required />
                    </div>
                    <div class="form-group">
                        <label>Email</label>
                        <input type="email" id="editEmail" value="${escapeHtml(currentUser.email)}" required />
                    </div>
                    <div class="form-group">
                        <label>Phone</label>
                        <input type="tel" id="editPhone" value="${escapeHtml(currentUser.phone || '')}" placeholder="+91 9999999999" />
                    </div>
                </div>
                <button type="submit" class="btn btn-primary" style="margin-top:0.5rem;">
                    <i class="fas fa-save"></i> Save Changes
                </button>
            </form>

            <!-- Academic Info (read-only) -->
            ${isStudent ? `
            <div class="profile-section-title" style="margin-top:2rem;"><i class="fas fa-graduation-cap"></i> Academic Info</div>
            <div style="display:grid; grid-template-columns: repeat(auto-fit,minmax(200px,1fr)); gap:1rem;">
                <div class="detail-card">
                    <div class="detail-item"><span class="detail-label">Roll No:</span><span class="detail-value">${escapeHtml(currentUser.roll_number || 'N/A')}</span></div>
                    <div class="detail-item"><span class="detail-label">Course:</span><span class="detail-value">${escapeHtml(currentUser.course || 'N/A')}</span></div>
                    <div class="detail-item"><span class="detail-label">Semester:</span><span class="detail-value">${escapeHtml(currentUser.semester || 'N/A')}</span></div>
                </div>
            </div>
            ` : ''}

            <!-- Change Password -->
            <div class="profile-section-title" style="margin-top:2rem;"><i class="fas fa-lock"></i> Change Password</div>
            <form id="changePasswordForm" onsubmit="submitChangePassword(event)">
                <div class="profile-edit-grid">
                    <div class="form-group">
                        <label>Current Password</label>
                        <input type="password" id="oldPassword" required placeholder="Enter current password" />
                    </div>
                    <div class="form-group">
                        <label>New Password</label>
                        <input type="password" id="newPassword" required placeholder="Min 6 characters" oninput="checkPasswordStrength(this.value)" />
                        <div class="password-strength" id="pwStrengthBar"></div>
                    </div>
                    <div class="form-group">
                        <label>Confirm New Password</label>
                        <input type="password" id="confirmPassword" required placeholder="Repeat new password" />
                    </div>
                </div>
                <button type="submit" class="btn btn-warning" style="margin-top:0.5rem;">
                    <i class="fas fa-key"></i> Change Password
                </button>
            </form>
        </div>`;
}

function checkPasswordStrength(pass) {
    const bar = document.getElementById('pwStrengthBar');
    if (!bar) return;
    let strength = 0;
    if (pass.length >= 6) strength++;
    if (pass.length >= 10) strength++;
    if (/[A-Z]/.test(pass)) strength++;
    if (/[0-9]/.test(pass)) strength++;
    if (/[^A-Za-z0-9]/.test(pass)) strength++;

    const colors = ['#ef4444', '#f59e0b', '#f59e0b', '#22c55e', '#22c55e'];
    const widths = ['20%', '40%', '60%', '80%', '100%'];
    bar.style.background = colors[strength - 1] || '#e2e8f0';
    bar.style.width = widths[strength - 1] || '0%';
}

async function saveProfile(e) {
    e.preventDefault();
    const name = document.getElementById('editName').value.trim();
    const email = document.getElementById('editEmail').value.trim();
    const phone = document.getElementById('editPhone').value.trim();

    if (!name || !email) { showNotification('Name and email are required', 'error'); return; }

    const resp = await apiCall(`/student/update_profile/${currentUser.id}`, 'PUT', { name, email, phone });
    if (!resp) return;
    if (resp.success) {
        // Update local user info
        currentUser.name = resp.user.name || name;
        currentUser.email = resp.user.email || email;
        currentUser.phone = resp.user.phone || phone;
        try {
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
        } catch(err) {}
        // Update header name
        const nameEl = document.getElementById('currentUserName');
        if (nameEl) nameEl.textContent = currentUser.name;
        showNotification('Profile updated successfully!', 'success');
    } else {
        showNotification(resp.message || 'Failed to update profile', 'error');
    }
}

async function submitChangePassword(e) {
    e.preventDefault();
    const oldPassword = document.getElementById('oldPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;

    if (newPassword !== confirmPassword) {
        showNotification('New passwords do not match!', 'error');
        return;
    }
    if (newPassword.length < 6) {
        showNotification('New password must be at least 6 characters', 'error');
        return;
    }

    const resp = await apiCall('/student/change_password', 'POST', {
        user_id: currentUser.id,
        old_password: oldPassword,
        new_password: newPassword
    });
    if (!resp) return;
    if (resp.success) {
        showNotification('Password changed successfully!', 'success');
        document.getElementById('changePasswordForm').reset();
        const bar = document.getElementById('pwStrengthBar');
        if (bar) { bar.style.width = '0%'; bar.style.background = '#e2e8f0'; }
    } else {
        showNotification(resp.message || 'Failed to change password', 'error');
    }
}

