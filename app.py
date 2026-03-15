from flask import Flask, request, jsonify, render_template, send_from_directory
from flask_cors import CORS
import pymysql
from pymysql.cursors import DictCursor
import pymysql.err as db_errors
import hashlib
from datetime import datetime
import logging
import os
import pandas as pd
from werkzeug.utils import secure_filename
from flask import url_for



# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Tell Flask that "this folder" is both for templates and static files
app = Flask(__name__, static_folder='static', template_folder='templates')

CORS(app)

UPLOAD_FOLDER = "uploads"
ALLOWED_EXTENSIONS = {"xls", "xlsx", "csv", "pdf", "doc", "docx"}

app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Route to serve uploaded files (downloads)
@app.route('/uploads/<path:filename>')
def uploaded_file(filename):
    try:
        return send_from_directory(app.config['UPLOAD_FOLDER'], filename, as_attachment=True)
    except Exception as e:
        logger.error(f"Error serving file {filename}: {e}")
        return jsonify({"success": False, "message": "File not found"}), 404


@app.route('/api/admin/download_material/<int:id>', methods=['GET'])
def download_material(id):
    try:
        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('SELECT file_path FROM study_materials WHERE id=%s', (id,))
        row = cursor.fetchone()
        conn.close()
        if not row:
            return jsonify({"success": False, "message": "Material not found"}), 404

        fp = row.get('file_path')
        if not fp:
            return jsonify({"success": False, "message": "No file associated with this material"}), 404

        # First try uploads folder
        stored_path = os.path.join(app.config['UPLOAD_FOLDER'], fp)
        if os.path.exists(stored_path):
            # Stream file with correct mimetype and content-length
            import mimetypes
            mime, _ = mimetypes.guess_type(stored_path)
            if not mime:
                mime = 'application/octet-stream'
            try:
                from flask import send_file
                file_size = os.path.getsize(stored_path)
                response = send_file(stored_path, mimetype=mime, as_attachment=True, download_name=os.path.basename(stored_path))
                response.headers['Content-Length'] = str(file_size)
                return response
            except Exception as e:
                logger.error(f"send_file error for {stored_path}: {e}")
                # fallback
                return send_from_directory(app.config['UPLOAD_FOLDER'], fp, as_attachment=True)

        # If fp looks like an absolute URL, redirect
        if fp.startswith('http://') or fp.startswith('https://'):
            from flask import redirect
            return redirect(fp)

        # If fp starts with '/', try resolving relative to project root and static folder
        if fp.startswith('/'):
            candidate = os.path.join(app.root_path, fp.lstrip('/'))
            if os.path.exists(candidate):
                return send_from_directory(os.path.dirname(candidate), os.path.basename(candidate), as_attachment=True)
            candidate2 = os.path.join(app.static_folder, fp.lstrip('/'))
            if os.path.exists(candidate2):
                return send_from_directory(os.path.dirname(candidate2), os.path.basename(candidate2), as_attachment=True)

        logger.warning(f"Requested file not found on disk: {stored_path} (checked uploads, project root, static)")
        return jsonify({"success": False, "message": "File not found on server"}), 404
    except Exception as e:
        logger.error(f"Download material error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500


@app.route('/api/admin/upload_assignment', methods=['POST'])
def upload_assignment():
    try:
        if 'file' not in request.files:
            return jsonify({"success": False, "message": "No file part in the request"}), 400
        file = request.files['file']
        if file.filename == '':
            return jsonify({"success": False, "message": "No selected file"}), 400

        filename = file.filename
        ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
        # allow only pdf/doc/docx for assignment files
        if ext not in {'pdf', 'doc', 'docx'}:
            return jsonify({"success": False, "message": "Only PDF/DOC/DOCX files are allowed for assignments"}), 400

        # ensure assignments table can hold file metadata (best-effort)
        try:
            conn = get_db_connection()
            cur = conn.cursor()
            try:
                cur.execute("SHOW COLUMNS FROM assignments")
                existing = [r.get('Field') for r in cur.fetchall()]
            except Exception:
                existing = []

            # Add missing columns one-by-one (older MySQL may not support IF NOT EXISTS)
            if 'file_path' not in existing:
                try:
                    cur.execute("ALTER TABLE assignments ADD COLUMN file_path VARCHAR(512) DEFAULT NULL")
                    conn.commit()
                except Exception:
                    pass
            if 'file_type' not in existing:
                try:
                    cur.execute("ALTER TABLE assignments ADD COLUMN file_type VARCHAR(20) DEFAULT NULL")
                    conn.commit()
                except Exception:
                    pass
            if 'file_size' not in existing:
                try:
                    cur.execute("ALTER TABLE assignments ADD COLUMN file_size BIGINT DEFAULT NULL")
                    conn.commit()
                except Exception:
                    pass
        except Exception:
            # if anything fails here, continue; upload will still save file on disk
            try:
                conn and conn.close()
            except Exception:
                pass

        # Secure and unique filename
        safe_name = secure_filename(filename)
        timestamp = datetime.now().strftime('%Y%m%d%H%M%S%f')
        stored_name = f"{timestamp}_{safe_name}"
        save_path = os.path.join(app.config['UPLOAD_FOLDER'], stored_name)
        file.save(save_path)

        title = request.form.get('title') or safe_name
        subject = request.form.get('subject') or ''
        description = request.form.get('description') or ''
        due_date = request.form.get('due_date') or None
        course = request.form.get('course')
        semester = request.form.get('semester')
        created_by = int(request.form.get('uploaded_by')) if request.form.get('uploaded_by') else 1
        file_type = ext
        try:
            file_size = int(os.path.getsize(save_path))
        except Exception:
            file_size = 0

        # Insert assignment record (without file_path first)
        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO assignments (title, subject, description, due_date, course, semester, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        ''', (title, subject, description, due_date, course, semester, created_by))
        conn.commit()
        assignment_id = cursor.lastrowid

        # Try to update file metadata (if columns exist)
        try:
            cursor.execute('UPDATE assignments SET file_path=%s, file_type=%s, file_size=%s WHERE id=%s', (stored_name, file_type, file_size, assignment_id))
            conn.commit()
        except Exception:
            # ignore if columns missing
            pass

        conn.close()

        return jsonify({"success": True, "message": "Assignment uploaded successfully", "assignment_id": assignment_id})
    except Exception as e:
        logger.error(f"Upload assignment error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

@app.route('/api/admin/upload_material', methods=['POST'])
def upload_material_file():
    try:
        if 'file' not in request.files:
            return jsonify({"success": False, "message": "No file part in the request"}), 400
        file = request.files['file']
        if file.filename == '':
            return jsonify({"success": False, "message": "No selected file"}), 400

        filename = file.filename
        ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
        
        # Secure and unique filename
        safe_name = secure_filename(filename)
        timestamp = datetime.now().strftime('%Y%m%d%H%M%S%f')
        stored_name = f"{timestamp}_{safe_name}"
        save_path = os.path.join(app.config['UPLOAD_FOLDER'], stored_name)
        file.save(save_path)

        title = request.form.get('title') or safe_name
        subject = request.form.get('subject') or ''
        description = request.form.get('description') or ''
        course = request.form.get('course')
        semester = request.form.get('semester')
        uploaded_by = int(request.form.get('uploaded_by')) if request.form.get('uploaded_by') else 1
        file_type = ext
        try:
            file_size = int(os.path.getsize(save_path))
        except Exception:
            file_size = 0

        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO study_materials (title, subject, description, file_path, file_type, file_size, uploaded_by, course, semester)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        ''', (title, subject, description, stored_name, file_type, file_size, uploaded_by, course, semester))
        conn.commit()
        material_id = cursor.lastrowid
        conn.close()

        return jsonify({"success": True, "message": "Material uploaded successfully", "material_id": material_id})
    except Exception as e:
        logger.error(f"Upload material file error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500


@app.route('/api/admin/download_assignment/<int:id>', methods=['GET'])
def download_assignment(id):
    try:
        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('SELECT file_path FROM assignments WHERE id=%s', (id,))
        row = cursor.fetchone()
        conn.close()
        if not row:
            return jsonify({"success": False, "message": "Assignment not found"}), 404

        fp = row.get('file_path')
        if not fp:
            return jsonify({"success": False, "message": "No file associated with this assignment"}), 404

        # Primary candidate: file path relative to uploads folder
        stored_path = os.path.join(app.config['UPLOAD_FOLDER'], fp)

        def _serve_file(path_to_file):
            import mimetypes
            mime, _ = mimetypes.guess_type(path_to_file)
            if not mime:
                mime = 'application/octet-stream'
            try:
                from flask import send_file
                file_size = os.path.getsize(path_to_file)
                response = send_file(path_to_file, mimetype=mime, as_attachment=True, download_name=os.path.basename(path_to_file))
                response.headers['Content-Length'] = str(file_size)
                return response
            except Exception as e:
                logger.error(f"send_file error for {path_to_file}: {e}")
                # fallback to send_from_directory
                try:
                    return send_from_directory(app.config['UPLOAD_FOLDER'], os.path.basename(path_to_file), as_attachment=True)
                except Exception as e2:
                    logger.error(f"send_from_directory fallback failed for {path_to_file}: {e2}")
                    return None

        # 1) Exact stored name in uploads
        if os.path.exists(stored_path):
            resp = _serve_file(stored_path)
            if resp:
                return resp

        # 2) If fp is an absolute path on disk, try serving it directly
        if os.path.isabs(fp) and os.path.exists(fp):
            resp = _serve_file(fp)
            if resp:
                return resp

        # 3) If fp contains a path separators, try basename in uploads
        basename = os.path.basename(fp)
        candidate = os.path.join(app.config['UPLOAD_FOLDER'], basename)
        if os.path.exists(candidate):
            resp = _serve_file(candidate)
            if resp:
                return resp

        # 4) Common situation: database stored original filename but saved file has a timestamp prefix.
        # Try to find any file in uploads/ that ends with the stored basename
        try:
            for fname in os.listdir(app.config['UPLOAD_FOLDER']):
                if fname == fp or fname == basename or fname.endswith('_' + basename) or fname.endswith(basename):
                    candidate2 = os.path.join(app.config['UPLOAD_FOLDER'], fname)
                    if os.path.exists(candidate2):
                        resp = _serve_file(candidate2)
                        if resp:
                            return resp
        except Exception as e:
            logger.error(f"Error while scanning uploads for assignment file '{fp}': {e}")

        # 5) If fp is an HTTP(S) URL, redirect
        if isinstance(fp, str) and (fp.startswith('http://') or fp.startswith('https://')):
            from flask import redirect
            return redirect(fp)

        logger.warning(f"Requested assignment file not found on disk (tried several candidates): {fp}")
        return jsonify({"success": False, "message": "File not found on server"}), 404
    except Exception as e:
        logger.error(f"Download assignment error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

# ----------------------------
# Logging Setup
# ----------------------------

DB_HOST = os.environ.get("DB_HOST", "localhost")
DB_PORT = int(os.environ.get("DB_PORT", 3306))
DB_USER = os.environ.get("DB_USER", "root")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "Pardhu_530")
DB_NAME = os.environ.get("DB_NAME", "student_portal")

# ----------------------------
# Database Helpers
# ----------------------------
def get_db_connection():
    try:
        conn = pymysql.connect(
            host=DB_HOST,
            port=DB_PORT,
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME,
            cursorclass=DictCursor,
            charset="utf8mb4",
            autocommit=False,
            auth_plugin_map={"caching_sha2_password": "mysql_native_password"},
        )
        with conn.cursor() as cur:
            cur.execute("SET FOREIGN_KEY_CHECKS = 1;")
        return conn
    except Exception as e:
        logger.error(f"Database connection error: {e}")
        return None

def hash_password(password):
    return hashlib.sha256(password.encode()).hexdigest()

def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS

def init_database():
    """Initialize DB tables + insert sample data"""
    try:
        conn = get_db_connection()
        if not conn:
            return False
        cursor = conn.cursor()


        # ---- Users table ----
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id INT PRIMARY KEY AUTO_INCREMENT,
                username VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) NOT NULL,
                user_type VARCHAR(50) NOT NULL,
                roll_number VARCHAR(100),
                course VARCHAR(255),
                semester VARCHAR(100),
                phone VARCHAR(50),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        ''')

        # ---- Assignments ----
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS assignments (
                id INT PRIMARY KEY AUTO_INCREMENT,
                title VARCHAR(255) NOT NULL,
                subject VARCHAR(255) NOT NULL,
                description TEXT,
                due_date DATE,
                course VARCHAR(255) DEFAULT NULL,
                semester VARCHAR(100) DEFAULT NULL,
                created_by INT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        ''')

        # ---- Assignment Submissions ----
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS assignment_submissions (
                id INT PRIMARY KEY AUTO_INCREMENT,
                assignment_id INT NOT NULL,
                student_id INT NOT NULL,
                file_path TEXT,
                submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                grade DOUBLE,
                feedback TEXT,
                FOREIGN KEY (assignment_id) REFERENCES assignments (id) ON DELETE CASCADE,
                FOREIGN KEY (student_id) REFERENCES users (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        ''')

        # ---- Courses ----
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS courses (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(255) UNIQUE NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        ''')

        # Seed with some default courses if table empty
        cursor.execute('SELECT COUNT(*) as cnt FROM courses')
        row = cursor.fetchone()
        if row and row.get('cnt', 0) == 0:
            default_courses = ['B.Sc Computer Science', 'B.A Economics', 'B.Com']
            for c in default_courses:
                try:
                    cursor.execute('INSERT INTO courses (name) VALUES (%s)', (c,))
                except Exception:
                    pass

        # ---- Announcements ----
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS announcements (
                id INT PRIMARY KEY AUTO_INCREMENT,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                priority VARCHAR(20) NOT NULL,
                created_by INT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        ''')

        # ---- Attendance ----
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS attendance (
                id INT PRIMARY KEY AUTO_INCREMENT,
                student_id INT NOT NULL,
                subject VARCHAR(255) NOT NULL,
                date DATE NOT NULL,
                status VARCHAR(20) NOT NULL,
                course VARCHAR(255) DEFAULT NULL,
                semester VARCHAR(100) DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (student_id) REFERENCES users (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        ''')

        # ---- Marks ----
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS marks (
                id INT PRIMARY KEY AUTO_INCREMENT,
                student_id INT NOT NULL,
                subject VARCHAR(255) NOT NULL,
                exam_type VARCHAR(255),
                marks_obtained DOUBLE,
                total_marks DOUBLE,
                grade VARCHAR(20),
                exam_date DATE,
                course VARCHAR(255) DEFAULT NULL,
                semester VARCHAR(100) DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (student_id) REFERENCES users (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        ''')


        # ---- Study Materials ----
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS study_materials (
                id INT PRIMARY KEY AUTO_INCREMENT,
                title VARCHAR(255) NOT NULL,
                subject VARCHAR(255) NOT NULL,
                description TEXT,
                file_path VARCHAR(500) NOT NULL,
                file_type VARCHAR(50),
                file_size INT,
                uploaded_by INT NULL,
                course VARCHAR(255) DEFAULT NULL,
                semester VARCHAR(100) DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (uploaded_by) REFERENCES users (id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        ''')

        # ---- Exams ----
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS exams (
                id INT PRIMARY KEY AUTO_INCREMENT,
                subject VARCHAR(255) NOT NULL,
                exam_type VARCHAR(255) NOT NULL,
                exam_date DATE NOT NULL,
                total_marks INT NOT NULL,
                course VARCHAR(255) DEFAULT NULL,
                semester VARCHAR(100) DEFAULT NULL,
                description TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        ''')


        # ---- Migration: Add missing columns if they don't exist ----
        try:
            cursor.execute("ALTER TABLE exams ADD COLUMN description TEXT AFTER semester")
        except: pass

        # Insert sample users (safe, will IGNORE if already present)
        sample_users = [
            ("admin", hash_password("admin123"), "Administrator", "admin@portal.edu", "admin", None, None, None, None),
            ("student", hash_password("student123"), "John Doe", "john@student.edu", "student", "CSE2023001", "Computer Science", "6th Semester", "+1234567890"),
            ("subadmin", hash_password("sub123"), "Sub Admin", "subadmin@portal.edu", "subadmin", None, None, None, None)
        ]
        cursor.executemany('''
            INSERT IGNORE INTO users (username,password,name,email,user_type,roll_number,course,semester,phone)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ''', sample_users)

        # Insert sample data for testing
        # Sample announcements
        sample_announcements = [
            ("Welcome to New Semester", "Welcome to the new academic semester. Please check your schedule.", "high", 1),
            ("Library Hours", "Library will remain open till 10 PM during exam weeks.", "medium", 1),
            ("Sports Day", "Annual sports day will be held next month. Register now!", "low", 1)
        ]
        cursor.executemany('''
            INSERT IGNORE INTO announcements (title, content, priority, created_by)
            VALUES (%s, %s, %s, %s)
        ''', sample_announcements)


        # Sample assignments
        sample_assignments = [
            ("Math Assignment 1", "Mathematics", "Solve calculus problems from chapter 5", "2025-02-15", 1),
            ("Physics Lab Report", "Physics", "Submit lab report on optics experiment", "2025-02-20", 1),
            ("Chemistry Project", "Chemistry", "Research project on organic compounds", "2025-02-25", 1)
        ]
        cursor.executemany('''
            INSERT IGNORE INTO assignments (title, subject, description, due_date, created_by)
            VALUES (%s, %s, %s, %s, %s)
        ''', sample_assignments)

        # Find the student user ID dynamically
        cursor.execute("SELECT id FROM users WHERE username='student'")
        student_row = cursor.fetchone()
        student_id = student_row['id'] if student_row else 2

        # Sample attendance for student
        sample_attendance = [
            (student_id, "Mathematics", "2025-01-15", "present"),
            (student_id, "Physics", "2025-01-15", "present"),
            (student_id, "Chemistry", "2025-01-16", "absent"),
            (student_id, "Mathematics", "2025-01-16", "present"),
            (student_id, "English", "2025-01-17", "late")
        ]
        cursor.executemany('''
            INSERT IGNORE INTO attendance (student_id, subject, date, status)
            VALUES (%s, %s, %s, %s)
        ''', sample_attendance)

        # Sample marks for student
        sample_marks = [
            (student_id, "Mathematics", "Midterm", 85, 100, "A", "2025-01-10"),
            (student_id, "Physics", "Quiz", 78, 100, "B+", "2025-01-12"),
            (student_id, "Chemistry", "Assignment", 92, 100, "A+", "2025-01-14"),
            (student_id, "English", "Essay", 88, 100, "A", "2025-01-16")
        ]
        cursor.executemany('''
            INSERT IGNORE INTO marks (student_id, subject, exam_type, marks_obtained, total_marks, grade, exam_date)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        ''', sample_marks)


        # Sample study materials
        sample_materials = [
            ("Mathematics Textbook", "Mathematics", "/materials/math_textbook.pdf", "pdf", 2048, 1),
            ("Physics Lab Manual", "Physics", "/materials/physics_lab.pdf", "pdf", 1536, 1),
            ("Chemistry Notes", "Chemistry", "/materials/chemistry_notes.pdf", "pdf", 1024, 1)
        ]
        cursor.executemany('''
            INSERT IGNORE INTO study_materials (title, subject, file_path, file_type, file_size, uploaded_by)
            VALUES (%s, %s, %s, %s, %s, %s)
        ''', sample_materials)

        conn.commit()
        conn.close()
        logger.info("Database initialized successfully with sample data")
        return True

    except Exception as e:
        logger.error(f"Database initialization error: {e}")
        return False

# ----------------------------
# Routes
# ----------------------------

# Render index
@app.route("/")
def serve_index():
    return render_template("index.html")

# ----------------------------
# Authentication Routes
# ----------------------------
@app.route("/api/auth/login", methods=["POST"])
def login():
    try:
        data = request.get_json()
        username = data.get("username")
        password = data.get("password")
        user_type = data.get("userType")

        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('''
            SELECT id, username, name, email, user_type, roll_number, course, semester, phone
            FROM users
            WHERE username=%s AND password=%s AND user_type=%s
        ''', (username, hash_password(password), user_type))
        user = cursor.fetchone()
        conn.close()

        if user:
            return jsonify({"success": True, "user": dict(user)})
        else:
            return jsonify({"success": False, "message": "Invalid credentials"}), 401
    except Exception as e:
        logger.error(f"Login error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

@app.route("/api/health")
def health():
    # Return time up to 5 decimal places for seconds
    current_time = datetime.now().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-1]  # Trim to 5 decimals
    return jsonify({"status": "healthy", "time": current_time}), 200

# ----------------------------
# Student Routes
# ----------------------------
@app.route("/api/student/attendance/<int:student_id>", methods=["GET"])
def get_student_attendance(student_id):
    try:
        logger.info(f"Fetching attendance for student_id: {student_id}")
        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('''
            SELECT subject, date, status, course, semester
            FROM attendance
            WHERE student_id = %s
            ORDER BY date DESC
        ''', (student_id,))
        attendance = cursor.fetchall()
        logger.info(f"Found {len(attendance)} attendance records for student_id: {student_id}")
        conn.close()
        return jsonify({"success": True, "attendance": [dict(a) for a in attendance]})
    except Exception as e:
        logger.error(f"Get student attendance error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

@app.route("/api/student/marks/<int:student_id>", methods=["GET"])
def get_student_marks(student_id):
    try:
        logger.info(f"Fetching marks for student_id: {student_id}")
        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('''
            SELECT subject, exam_type, marks_obtained, total_marks, grade, exam_date, course, semester
            FROM marks
            WHERE student_id = %s
            ORDER BY exam_date DESC
        ''', (student_id,))
        marks = cursor.fetchall()
        logger.info(f"Found {len(marks)} mark records for student_id: {student_id}")
        conn.close()
        return jsonify({"success": True, "marks": [dict(m) for m in marks]})
    except Exception as e:
        logger.error(f"Get student marks error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

@app.route("/api/student/assignments/<int:student_id>", methods=["GET"])
def get_student_assignments(student_id):
    try:
        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        # Try to include file_path if assignment table has it - some DBs/instances may not have the column
        try:
            cursor.execute('''
                SELECT a.id, a.title, a.subject, a.description, a.due_date, a.file_path,
                       CASE WHEN s.id IS NOT NULL THEN 'Submitted' ELSE 'Not Submitted' END as submission_status
                FROM assignments a
                LEFT JOIN assignment_submissions s ON a.id = s.assignment_id AND s.student_id = %s
                ORDER BY a.due_date ASC
            ''', (student_id,))
        except Exception:
            # Fallback: query without file_path for older schema
            cursor.execute('''
                SELECT a.id, a.title, a.subject, a.description, a.due_date,
                       CASE WHEN s.id IS NOT NULL THEN 'Submitted' ELSE 'Not Submitted' END as submission_status
                FROM assignments a
                LEFT JOIN assignment_submissions s ON a.id = s.assignment_id AND s.student_id = %s
                ORDER BY a.due_date ASC
            ''', (student_id,))
        assignments = cursor.fetchall()
        conn.close()
        return jsonify({"success": True, "assignments": [dict(a) for a in assignments]})
    except Exception as e:
        logger.error(f"Get student assignments error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500


@app.route("/api/student/announcements", methods=["GET"])
def get_student_announcements():
    try:
        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('''
            SELECT title, content, priority, created_at
            FROM announcements
            ORDER BY created_at DESC
            LIMIT 10
        ''')
        announcements = cursor.fetchall()
        conn.close()
        return jsonify({"success": True, "announcements": [dict(a) for a in announcements]})
    except Exception as e:
        logger.error(f"Get student announcements error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

@app.route("/api/student/materials", methods=["GET"])
def get_student_materials():
    try:
        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('''
            SELECT id, title, subject, file_path, file_type, file_size, created_at
            FROM study_materials
            ORDER BY created_at DESC
        ''')
        materials = cursor.fetchall()
        conn.close()

        return jsonify({"success": True, "materials": [dict(m) for m in materials]})
    except Exception as e:
        logger.error(f"Get student materials error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

@app.route("/api/student/exams", methods=["GET"])
def get_student_exams():
    try:
        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        # Return exams - later this can be filtered by student's course/semester
        cursor.execute("SELECT id, subject, exam_type, exam_date, course, semester, description FROM exams ORDER BY exam_date DESC")
        rows = cursor.fetchall()
        conn.close()
        return jsonify({"success": True, "exams": [dict(r) for r in rows]})
    except Exception as e:
        logger.error(f"Get student exams error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500


# ----------------------------
# Admin User Management APIs
# ----------------------------
@app.route("/api/admin/bulk_add_users", methods=["POST"])
def bulk_add_users():
    if "file" not in request.files:
        return jsonify({"success": False, "message": "No file part in the request"}), 400
    file = request.files["file"]
    if file.filename == "":
        return jsonify({"success": False, "message": "No selected file"}), 400
    if not allowed_file(file.filename):
        return jsonify({"success": False, "message": "File type not allowed"}), 400

    filename = secure_filename(file.filename)
    filepath = os.path.join(app.config["UPLOAD_FOLDER"], filename)
    file.save(filepath)

    try:
        if filename.lower().endswith('.csv'):
            df = pd.read_csv(filepath)
        else:
            df = pd.read_excel(filepath)
    except Exception as e:
        return jsonify({"success": False, "message": f"Failed to read file: {e}"}), 400

    required_columns = {"username", "password", "name", "email", "user_type"}
    missing_cols = required_columns - set(df.columns.str.lower())
    if missing_cols:
        return jsonify({"success": False, "message": f"Missing required columns: {', '.join(missing_cols)}"}), 400

    # Normalize column names to lowercase for consistent access
    df.columns = df.columns.str.lower()

    success_count = 0
    failure_count = 0
    failure_details = []

    conn = get_db_connection()
    if not conn:
        return jsonify({"success": False, "message": "Database connection failed"}), 500
    cursor = conn.cursor()

    for index, row in df.iterrows():
        try:
            username = str(row.get("username")).strip()
            password = str(row.get("password")).strip()
            name = str(row.get("name")).strip()
            email = str(row.get("email")).strip()
            user_type = str(row.get("user_type")).strip()
            roll_number = str(row.get("roll_number")).strip() if "roll_number" in df.columns else None
            course = str(row.get("course")).strip() if "course" in df.columns else None
            semester = str(row.get("semester")).strip() if "semester" in df.columns else None
            phone = str(row.get("phone")).strip() if "phone" in df.columns else None

            if not username or not password or not name or not email or not user_type:
                failure_count += 1
                failure_details.append(f"Row {index+2}: Missing required user data")
                continue

            cursor.execute('''
                INSERT INTO users (username, password, name, email, user_type, roll_number, course, semester, phone)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ''', (username, hash_password(password), name, email, user_type, roll_number, course, semester, phone))
            success_count += 1
        except db_errors.IntegrityError:
            failure_count += 1
            failure_details.append(f"Row {index+2}: Username '{username}' already exists")
        except Exception as e:
            failure_count += 1
            failure_details.append(f"Row {index+2}: {str(e)}")

    conn.commit()
    conn.close()

    return jsonify({
        "success": True,
        "message": f"Bulk user upload completed: {success_count} added, {failure_count} failed",
        "failures": failure_details
    })

@app.route("/api/admin/add_user", methods=["POST"])
def add_user():
    try:
        data = request.get_json()
        username = data.get("username")
        password = data.get("password")
        name = data.get("name")
        email = data.get("email")
        user_type = data.get("user_type")
        roll_number = data.get("roll_number")
        course = data.get("course")
        semester = data.get("semester")
        phone = data.get("phone")

        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO users (username, password, name, email, user_type, roll_number, course, semester, phone)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        ''', (username, hash_password(password), name, email, user_type, roll_number, course, semester, phone))
        conn.commit()
        conn.close()

        return jsonify({"success": True, "message": "User added successfully"})
    except db_errors.IntegrityError:
        return jsonify({"success": False, "message": "Username already exists"}), 400
    except Exception as e:
        logger.error(f"Add user error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

@app.route("/api/admin/get_users", methods=["GET"])
def get_users():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('''
            SELECT id, username, name, email, user_type, roll_number, course, semester, phone
            FROM users
        ''')
        users = cursor.fetchall()
        conn.close()

        users_list = [dict(u) for u in users]
        return jsonify({"success": True, "users": users_list})
    except Exception as e:
        logger.error(f"Get users error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

@app.route("/api/admin/delete_user/<int:user_id>", methods=["DELETE"])
def delete_user(user_id):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('DELETE FROM users WHERE id=%s', (user_id,))
        conn.commit()
        conn.close()
        return jsonify({"success": True, "message": "User deleted successfully"})
    except Exception as e:
        logger.error(f"Delete user error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

# ----------------------------
# Admin Data Management APIs
# ----------------------------
@app.route("/api/admin/get_assignments", methods=["GET"])
def get_assignments():
    try:
        # Allow optional server-side filtering by course and semester to avoid client-side mismatch
        course = request.args.get('course')
        semester = request.args.get('semester')

        conn = get_db_connection()
        cursor = conn.cursor()
        sql = 'SELECT * FROM assignments WHERE 1=1 '
        params = []
        if course:
            # Case-insensitive match for course name
            sql += ' AND LOWER(course) = LOWER(%s) '
            params.append(course)
        if semester:
            sem = semester.strip()
            # If a numeric semester was supplied (e.g. '6'), try to match both numeric and common textual formats
            if sem.isdigit():
                try:
                    n = int(sem)
                    # compute common ordinal suffix (1st, 2nd, 3rd, 4th...)
                    if 11 <= (n % 100) <= 13:
                        suf = 'th'
                    else:
                        if n % 10 == 1:
                            suf = 'st'
                        elif n % 10 == 2:
                            suf = 'nd'
                        elif n % 10 == 3:
                            suf = 'rd'
                        else:
                            suf = 'th'
                    sem_text = f"{n}{suf} Semester"
                except Exception:
                    sem_text = f"{sem}th Semester"

                # match exact numeric, ordinal text, or any value containing the number (covers 'Semester 6', '6th Semester', etc.)
                sql += ' AND (semester = %s OR LOWER(semester) = LOWER(%s) OR semester LIKE %s) '
                params.append(sem)
                params.append(sem_text)
                params.append(f"%{sem}%")
            else:
                # Non-numeric semester: do case-insensitive exact match
                sql += ' AND LOWER(semester) = LOWER(%s) '
                params.append(semester)

        sql += ' ORDER BY created_at DESC'
        cursor.execute(sql, tuple(params))
        rows = cursor.fetchall()
        conn.close()
        return jsonify({"success": True, "assignments": [dict(r) for r in rows]})
    except Exception as e:
        logger.error(f"Get assignments error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

@app.route("/api/admin/get_attendance", methods=["GET"])
def get_attendance():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM attendance ORDER BY date DESC')
        rows = cursor.fetchall()
        conn.close()
        return jsonify({"success": True, "attendance": [dict(r) for r in rows]})
    except Exception as e:
        logger.error(f"Get attendance error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

@app.route("/api/admin/get_marks", methods=["GET"])
def get_marks():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM marks ORDER BY exam_date DESC')
        rows = cursor.fetchall()
        conn.close()
        return jsonify({"success": True, "marks": [dict(r) for r in rows]})
    except Exception as e:
        logger.error(f"Get marks error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

@app.route("/api/admin/get_announcements", methods=["GET"])
def get_announcements():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM announcements ORDER BY created_at DESC')
        rows = cursor.fetchall()
        conn.close()
        return jsonify({"success": True, "announcements": [dict(r) for r in rows]})
    except Exception as e:
        logger.error(f"Get announcements error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500
    
    
@app.route("/admin/bulk_add_attendance", methods=["POST"])
@app.route("/api/admin/bulk_add_attendance", methods=["POST"])
def bulk_add_attendance():
    file = request.files.get("file")
    description = request.form.get("description")
    uploaded_by = request.form.get("uploaded_by")
    selected_course = request.form.get("course")
    selected_semester = request.form.get("semester")

    if not file:
        return jsonify({"success": False, "message": "No file uploaded"}), 400

    try:
        # Save file
        file_path = os.path.join(UPLOAD_FOLDER, secure_filename(file.filename))
        file.save(file_path)

        # Read Excel or CSV
        if file.filename.endswith((".xls", ".xlsx")):
            df = pd.read_excel(file_path)
        else:
            df = pd.read_csv(file_path)

        # Normalize column names to lowercase
        df.columns = df.columns.str.lower()

        # Required columns
        required_columns = {"roll_number", "subject", "date", "status"}
        missing_cols = required_columns - set(df.columns)
        if missing_cols:
            return jsonify({"success": False, "message": f"Missing required columns: {', '.join(missing_cols)}"}), 400

        success_count = 0
        failure_count = 0
        failure_details = []

        conn = get_db_connection()
        cursor = conn.cursor()

        for index, row in df.iterrows():
            try:
                roll_number = str(row.get("roll_number")).strip()
                subject = str(row.get("subject")).strip()
                date = str(row.get("date")).strip()
                status = str(row.get("status")).strip().lower()

                # Use selected course/semester if provided, else use from row
                course = selected_course if selected_course else (str(row.get("course")).strip() if "course" in df.columns and pd.notna(row.get("course")) else None)
                semester = selected_semester if selected_semester else (str(row.get("semester")).strip() if "semester" in df.columns and pd.notna(row.get("semester")) else None)

                if not roll_number or not subject or not date or not status:
                    failure_count += 1
                    failure_details.append(f"Row {index+2}: Missing required data")
                    continue

                if status not in ['present', 'absent', 'late']:
                    failure_count += 1
                    failure_details.append(f"Row {index+2}: Invalid status '{status}'")
                    continue

                cursor.execute("SELECT id FROM users WHERE roll_number = %s", (roll_number,))
                student = cursor.fetchone()
                if not student:
                    failure_count += 1
                    failure_details.append(f"Row {index+2}: Roll number '{roll_number}' not found")
                    continue

                student_id = student['id']

                cursor.execute('''
                    INSERT INTO attendance (student_id, subject, date, status, course, semester)
                    VALUES (%s, %s, %s, %s, %s, %s)
                ''', (student_id, subject, date, status, course, semester))
                success_count += 1
            except Exception as e:
                failure_count += 1
                failure_details.append(f"Row {index+2}: {str(e)}")

        conn.commit()
        conn.close()
        if os.path.exists(file_path): os.remove(file_path)

        return jsonify({
            "success": True,
            "message": f"Bulk attendance upload completed: {success_count} added, {failure_count} failed",
            "added_count": success_count,
            "failures": failure_details
        })
    except Exception as e:
        logger.error(f"Bulk attendance error: {e}")
        return jsonify({"success": False, "message": str(e)}), 500


# ---------------- MARKS ----------------
@app.route("/admin/bulk_add_marks", methods=["POST"])
@app.route("/api/admin/bulk_add_marks", methods=["POST"])
def bulk_add_marks():
    file = request.files.get("file")
    description = request.form.get("description")
    uploaded_by = request.form.get("uploaded_by")
    selected_course = request.form.get("course")
    selected_semester = request.form.get("semester")

    if not file:
        return jsonify({"success": False, "message": "No file uploaded"}), 400

    try:
        # Save file
        file_path = os.path.join(UPLOAD_FOLDER, secure_filename(file.filename))
        file.save(file_path)

        # Read Excel or CSV
        if file.filename.endswith((".xls", ".xlsx")):
            df = pd.read_excel(file_path)
        else:
            df = pd.read_csv(file_path)

        # Normalize column names to lowercase
        df.columns = df.columns.str.lower()

        # Required columns
        required_columns = {"roll_number", "subject", "marks_obtained"}
        missing_cols = required_columns - set(df.columns)
        if missing_cols:
            return jsonify({"success": False, "message": f"Missing required columns: {', '.join(missing_cols)}"}), 400

        success_count = 0
        failure_count = 0
        failure_details = []

        conn = get_db_connection()
        cursor = conn.cursor()

        for index, row in df.iterrows():
            try:
                roll_number = str(row.get("roll_number")).strip()
                subject = str(row.get("subject")).strip()
                marks_obtained = row.get("marks_obtained")
                exam_type = str(row.get("exam_type")).strip() if "exam_type" in df.columns and pd.notna(row.get("exam_type")) else None
                total_marks = row.get("total_marks") if "total_marks" in df.columns and pd.notna(row.get("total_marks")) else 100
                grade = str(row.get("grade")).strip() if "grade" in df.columns and pd.notna(row.get("grade")) else None
                exam_date = str(row.get("exam_date")).strip() if "exam_date" in df.columns and pd.notna(row.get("exam_date")) else None

                # Use selected course/semester if provided, else from row
                course = selected_course if selected_course else (str(row.get("course")).strip() if "course" in df.columns and pd.notna(row.get("course")) else None)
                semester = selected_semester if selected_semester else (str(row.get("semester")).strip() if "semester" in df.columns and pd.notna(row.get("semester")) else None)

                if not roll_number or not subject or marks_obtained is None:
                    failure_count += 1
                    failure_details.append(f"Row {index+2}: Missing required data")
                    continue

                cursor.execute("SELECT id FROM users WHERE roll_number = %s", (roll_number,))
                student = cursor.fetchone()
                if not student:
                    failure_count += 1
                    failure_details.append(f"Row {index+2}: Roll number '{roll_number}' not found")
                    continue

                student_id = student['id']

                cursor.execute('''
                    INSERT INTO marks (student_id, subject, exam_type, marks_obtained, total_marks, grade, exam_date, course, semester)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ''', (student_id, subject, exam_type, marks_obtained, total_marks, grade, exam_date, course, semester))
                success_count += 1
            except Exception as e:
                failure_count += 1
                failure_details.append(f"Row {index+2}: {str(e)}")

        conn.commit()
        conn.close()
        if os.path.exists(file_path): os.remove(file_path)

        return jsonify({
            "success": True,
            "message": f"Bulk marks upload completed: {success_count} added, {failure_count} failed",
            "added_count": success_count,
            "failures": failure_details
        })
    except Exception as e:
        logger.error(f"Bulk marks error: {e}")
        return jsonify({"success": False, "message": str(e)}), 500

@app.route("/api/admin/get_materials", methods=["GET"])
def get_materials():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM study_materials ORDER BY created_at DESC')
        rows = cursor.fetchall()
        conn.close()
        materials = []
        for r in rows:
            rec = dict(r)
            fp = rec.get('file_path')
            exists = False
            if fp:
                # check uploads
                upath = os.path.join(app.config['UPLOAD_FOLDER'], fp)
                if os.path.exists(upath):
                    exists = True
                else:
                    # check project root / static for legacy paths starting with /
                    if fp.startswith('/'):
                        candidate = os.path.join(app.root_path, fp.lstrip('/'))
                        candidate2 = os.path.join(app.static_folder, fp.lstrip('/'))
                        if os.path.exists(candidate) or os.path.exists(candidate2):
                            exists = True
            rec['file_exists'] = exists
            rec['download_url'] = f"/api/admin/download_material/{rec.get('id')}"
            materials.append(rec)
        return jsonify({"success": True, "materials": materials})
    except Exception as e:
        logger.error(f"Get materials error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500


@app.route("/api/admin/get_exams", methods=["GET"])
def get_exams():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM exams ORDER BY exam_date DESC")
        rows = cursor.fetchall()
        conn.close()
        return jsonify({"success": True, "exams": [dict(r) for r in rows]})
    except Exception as e:
        logger.error(f"Get exams error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500



# ---------------------------- Admin Add/Edit APIs ----------------------------


@app.route("/api/admin/delete_assignment/<int:id>", methods=["DELETE"])
def delete_assignment(id):
    try:
        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('DELETE FROM assignments WHERE id=%s', (id,))
        conn.commit()
        conn.close()
        return jsonify({"success": True, "message": "Assignment deleted successfully"})
    except Exception as e:
        logger.error(f"Delete assignment error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

@app.route("/api/admin/delete_attendance/<int:id>", methods=["DELETE"])
def delete_attendance(id):
    try:
        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('DELETE FROM attendance WHERE id=%s', (id,))
        conn.commit()
        conn.close()
        return jsonify({"success": True, "message": "Attendance record deleted successfully"})
    except Exception as e:
        logger.error(f"Delete attendance error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

@app.route("/api/admin/delete_mark/<int:id>", methods=["DELETE"])
def delete_mark(id):
    try:
        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('DELETE FROM marks WHERE id=%s', (id,))
        conn.commit()
        conn.close()
        return jsonify({"success": True, "message": "Mark record deleted successfully"})
    except Exception as e:
        logger.error(f"Delete mark error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

@app.route("/api/admin/delete_announcement/<int:id>", methods=["DELETE"])
def delete_announcement(id):
    try:
        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('DELETE FROM announcements WHERE id=%s', (id,))
        conn.commit()
        conn.close()
        return jsonify({"success": True, "message": "Announcement deleted successfully"})
    except Exception as e:
        logger.error(f"Delete announcement error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

@app.route("/api/admin/delete_material/<int:id>", methods=["DELETE"])
def delete_material(id):
    try:
        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('DELETE FROM study_materials WHERE id=%s', (id,))
        conn.commit()
        conn.close()
        return jsonify({"success": True, "message": "Material deleted successfully"})
    except Exception as e:
        logger.error(f"Delete material error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

@app.route("/api/admin/delete_exam/<int:id>", methods=["DELETE"])
def delete_exam(id):
    try:
        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('DELETE FROM exams WHERE id=%s', (id,))
        conn.commit()
        conn.close()
        return jsonify({"success": True, "message": "Exam deleted successfully"})
    except Exception as e:
        logger.error(f"Delete exam error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500


@app.route("/api/admin/add_assignment", methods=["POST"])
def add_assignment():
    try:
        data = request.get_json()
        title = data.get("title")
        subject = data.get("subject")
        description = data.get("description")
        due_date = data.get("due_date")
        course = data.get("course")
        semester = data.get("semester")
        created_by = data.get("created_by", 1)  # Default to admin

        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO assignments (title, subject, description, due_date, course, semester, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        ''', (title, subject, description, due_date, course, semester, created_by))
        conn.commit()
        conn.close()

        return jsonify({"success": True, "message": "Assignment added successfully"})
    except Exception as e:
        logger.error(f"Add assignment error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

@app.route("/api/admin/add_attendance", methods=["POST"])
def add_attendance():
    try:
        data = request.get_json()
        student_id = data.get("student_id")
        subject = data.get("subject")
        date = data.get("date")
        status = data.get("status")
        course = data.get("course")
        semester = data.get("semester")

        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO attendance (student_id, subject, date, status, course, semester)
            VALUES (%s, %s, %s, %s, %s, %s)
        ''', (student_id, subject, date, status, course, semester))
        conn.commit()
        conn.close()

        return jsonify({"success": True, "message": "Attendance added successfully"})
    except Exception as e:
        logger.error(f"Add attendance error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

@app.route("/api/admin/add_mark", methods=["POST"])
def add_mark():
    try:
        data = request.get_json()
        student_id = data.get("student_id")
        subject = data.get("subject")
        exam_type = data.get("exam_type")
        marks_obtained = data.get("marks_obtained")
        total_marks = data.get("total_marks")
        grade = data.get("grade")
        exam_date = data.get("exam_date")
        course = data.get("course")
        semester = data.get("semester")

        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO marks (student_id, subject, exam_type, marks_obtained, total_marks, grade, exam_date, course, semester)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        ''', (student_id, subject, exam_type, marks_obtained, total_marks, grade, exam_date, course, semester))
        conn.commit()
        conn.close()

        return jsonify({"success": True, "message": "Mark added successfully"})
    except Exception as e:
        logger.error(f"Add mark error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500

@app.route("/api/admin/add_announcement", methods=["POST"])
def add_announcement():
    try:
        data = request.get_json()
        title = data.get("title")
        content = data.get("content")
        priority = data.get("priority")
        created_by = data.get("created_by", 1)  # Default to admin
        course = data.get("course")
        semester = data.get("semester")

        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        # Ensure announcements table can hold course/semester (best-effort)
        try:
            cursor.execute("ALTER TABLE announcements ADD COLUMN IF NOT EXISTS course VARCHAR(255) DEFAULT NULL, ADD COLUMN IF NOT EXISTS semester VARCHAR(100) DEFAULT NULL")
            conn.commit()
        except Exception:
            # ignore alter errors (older MySQL versions may not support IF NOT EXISTS)
            pass

        try:
            cursor.execute('''
                INSERT INTO announcements (title, content, priority, created_by, course, semester)
                VALUES (%s, %s, %s, %s, %s, %s)
            ''', (title, content, priority, created_by, course, semester))
        except Exception:
            # fallback if the table doesn't have course/semester columns
            cursor.execute('''
                INSERT INTO announcements (title, content, priority, created_by)
                VALUES (%s, %s, %s, %s)
            ''', (title, content, priority, created_by))
        conn.commit()
        conn.close()

        return jsonify({"success": True, "message": "Announcement added successfully"})
    except Exception as e:
        logger.error(f"Add announcement error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500


@app.route("/api/admin/add_exam", methods=["POST"])
def add_exam():
    try:
        data = request.get_json()
        subject = data.get("subject")
        exam_type = data.get("exam_type")
        exam_date = data.get("exam_date")
        total_marks = data.get("total_marks")
        course = data.get("course")
        semester = data.get("semester")

        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO exams (subject, exam_type, exam_date, total_marks, course, semester)
            VALUES (%s, %s, %s, %s, %s, %s)
        ''', (subject, exam_type, exam_date, total_marks, course, semester))
        conn.commit()
        conn.close()

        return jsonify({"success": True, "message": "Exam added successfully"})
    except Exception as e:
        logger.error(f"Add exam error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500



@app.route("/api/admin/add_material", methods=["POST"])
def add_material():
    try:
        data = request.get_json()
        title = data.get("title")
        subject = data.get("subject")
        file_path = data.get("file_path")
        file_type = data.get("file_type")
        description = data.get("description")
        file_size = data.get("file_size") or 0
        uploaded_by = data.get("uploaded_by", 1)
        course = data.get("course")
        semester = data.get("semester")

        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO study_materials (title, subject, description, file_path, file_type, file_size, uploaded_by, course, semester)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        ''', (title, subject, description, file_path, file_type, file_size, uploaded_by, course, semester))
        conn.commit()
        conn.close()

        return jsonify({"success": True, "message": "Material added successfully"})
    except Exception as e:
        logger.error(f"Add material error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500


# Error Handlers
@app.errorhandler(404)
def not_found(e):
    return jsonify({"success": False, "message": "Endpoint not found"}), 404

@app.errorhandler(500)
def internal_error(e):
    return jsonify({"success": False, "message": "Internal server error"}), 500


@app.route('/api/admin/courses', methods=['GET'])
def list_courses():
    try:
        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "DB connection failed"}), 500
        cur = conn.cursor()
        # detect if courses table has a course_code column and select it if present
        cur.execute("SHOW COLUMNS FROM courses LIKE 'course_code'")
        has_course_code = cur.fetchone() is not None
        if has_course_code:
            cur.execute('SELECT id, name, course_code, created_at, updated_at FROM courses ORDER BY name')
        else:
            cur.execute('SELECT id, name, created_at, updated_at FROM courses ORDER BY name')
        rows = cur.fetchall()
        conn.close()
        return jsonify({"success": True, "courses": rows, "has_course_code": has_course_code})
    except Exception as e:
        logger.error(f"list_courses error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500


@app.route('/api/debug/assignments_with_files', methods=['GET'])
def debug_assignments_with_files():
    """Debug helper: return recent assignments that have a file_path set.
    Useful for testing download endpoints without direct DB access tools.
    """
    try:
        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "DB connection failed"}), 500
        cur = conn.cursor()
        cur.execute("SELECT id, title, file_path, created_at FROM assignments WHERE file_path IS NOT NULL AND file_path != '' ORDER BY created_at DESC LIMIT 50")
        rows = cur.fetchall()
        conn.close()
        return jsonify({"success": True, "assignments": rows})
    except Exception as e:
        logger.error(f"debug_assignments_with_files error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500


@app.route('/api/admin/courses', methods=['POST'])
def create_course():
    try:
        data = request.get_json() or {}
        name = (data.get('name') or '').strip()
        if not name:
            return jsonify({"success": False, "message": "Course name required"}), 400

        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "DB connection failed"}), 500
        cur = conn.cursor()
        # Prevent duplicate by name
        cur.execute('SELECT id FROM courses WHERE name=%s', (name,))
        if cur.fetchone():
            conn.close()
            return jsonify({"success": False, "message": "Course already exists"}), 400

        # If client provided a course_code ensure uniqueness before attempting insert
        provided_code = (data.get('course_code') or '').strip()
        if provided_code:
            try:
                cur.execute('SELECT id FROM courses WHERE course_code=%s', (provided_code,))
                if cur.fetchone():
                    conn.close()
                    return jsonify({"success": False, "message": "Course code already exists"}), 400
            except Exception:
                # If the column doesn't exist this will throw, ignore and continue
                pass

        # Build a safe insert that handles extra non-null columns present in the DB
        # Fetch column metadata and construct values for required columns
        cur.execute("SHOW COLUMNS FROM courses")
        cols = cur.fetchall()

        insert_cols = []
        insert_vals = []

        for col in cols:
            col_name = col.get('Field')
            if col_name in ('id', 'created_at', 'updated_at'):
                continue

            # prefer explicit client-provided value
            if col_name == 'name':
                insert_cols.append('name')
                insert_vals.append(name)
                continue

            provided = data.get(col_name)
            if provided is not None:
                insert_cols.append(col_name)
                insert_vals.append(provided)
                continue

            # if column does not allow null and has no default, supply a safe fallback
            if col.get('Null') == 'NO' and col.get('Default') is None:
                ctype = (col.get('Type') or '').lower()
                if 'int' in ctype or 'decimal' in ctype or 'float' in ctype or 'double' in ctype:
                    fallback = 0
                else:
                    fallback = ''
                insert_cols.append(col_name)
                insert_vals.append(fallback)
            else:
                # allow NULL or defaulted columns to be omitted
                pass

        if not insert_cols:
            conn.close()
            return jsonify({"success": False, "message": "No insertable columns found"}), 500

        placeholders = ','.join(['%s'] * len(insert_vals))
        cols_str = ','.join(insert_cols)
        sql = f'INSERT INTO courses ({cols_str}) VALUES ({placeholders})'
        cur.execute(sql, tuple(insert_vals))
        conn.commit()
        new_id = cur.lastrowid
        conn.close()
        return jsonify({"success": True, "message": "Course created", "id": new_id})
    except Exception as e:
        logger.error(f"create_course error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500


@app.route('/api/admin/courses/<int:course_id>', methods=['PUT'])
def update_course(course_id):
    try:
        data = request.get_json() or {}
        new_name = (data.get('name') or '').strip()
        if not new_name:
            return jsonify({"success": False, "message": "Course name required"}), 400

        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "DB connection failed"}), 500
        cur = conn.cursor()
        # Prevent duplicate names
        cur.execute('SELECT id FROM courses WHERE name=%s AND id!=%s', (new_name, course_id))
        if cur.fetchone():
            conn.close()
            return jsonify({"success": False, "message": "Another course with that name exists"}), 400

        # Also handle course_code if present and supplied
        cur.execute("SHOW COLUMNS FROM courses LIKE 'course_code'")
        has_course_code = cur.fetchone() is not None
        if has_course_code:
            new_code = (data.get('course_code') or '').strip()
            if new_code:
                # ensure uniqueness among other rows
                cur.execute('SELECT id FROM courses WHERE course_code=%s AND id!=%s', (new_code, course_id))
                if cur.fetchone():
                    conn.close()
                    return jsonify({"success": False, "message": "Another course with that code exists"}), 400
                cur.execute('UPDATE courses SET name=%s, course_code=%s WHERE id=%s', (new_name, new_code, course_id))
            else:
                cur.execute('UPDATE courses SET name=%s WHERE id=%s', (new_name, course_id))
        else:
            cur.execute('UPDATE courses SET name=%s WHERE id=%s', (new_name, course_id))
        conn.commit()
        conn.close()
        return jsonify({"success": True, "message": "Course updated"})
    except Exception as e:
        logger.error(f"update_course error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500


@app.route('/api/admin/courses/<int:course_id>', methods=['DELETE'])
def delete_course(course_id):
    try:
        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "DB connection failed"}), 500
        cur = conn.cursor()
        # remove course
        cur.execute('SELECT id, name FROM courses WHERE id=%s', (course_id,))
        row = cur.fetchone()
        if not row:
            conn.close()
            return jsonify({"success": False, "message": "Course not found"}), 404

        course_name = row.get('name')
        # set any users using this course to NULL
        try:
            cur.execute('UPDATE users SET course=NULL WHERE course=%s', (course_name,))
        except Exception:
            pass

        cur.execute('DELETE FROM courses WHERE id=%s', (course_id,))
        conn.commit()
        conn.close()
        return jsonify({"success": True, "message": "Course deleted"})
    except Exception as e:
        logger.error(f"delete_course error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500
    


# ----------------------------
# New Feature Endpoints
# ----------------------------

@app.route('/api/student/dashboard_stats/<int:student_id>', methods=['GET'])
def get_student_dashboard_stats(student_id):
    """Returns dashboard stats: attendance %, avg marks, pending assignments count."""
    try:
        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()

        # Attendance stats
        cursor.execute("SELECT status FROM attendance WHERE student_id = %s", (student_id,))
        att_rows = cursor.fetchall()
        total_att = len(att_rows)
        present = sum(1 for r in att_rows if r.get('status') == 'present')
        att_pct = round((present / total_att * 100), 1) if total_att > 0 else 0

        # Average marks
        cursor.execute("SELECT marks_obtained, total_marks FROM marks WHERE student_id = %s", (student_id,))
        marks_rows = cursor.fetchall()
        avg_marks = 0
        if marks_rows:
            scored = sum(r['marks_obtained'] for r in marks_rows if r.get('marks_obtained') is not None)
            total = sum(r['total_marks'] for r in marks_rows if r.get('total_marks') is not None)
            avg_marks = round((scored / total * 100), 1) if total > 0 else 0

        # Pending assignments (not submitted)
        cursor.execute('''
            SELECT COUNT(*) as cnt FROM assignments a
            LEFT JOIN assignment_submissions s ON a.id = s.assignment_id AND s.student_id = %s
            WHERE s.id IS NULL
        ''', (student_id,))
        pending_row = cursor.fetchone()
        pending_assignments = pending_row['cnt'] if pending_row else 0

        # Recent announcements count (last 7 days)
        cursor.execute('''
            SELECT COUNT(*) as cnt FROM announcements
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        ''')
        ann_row = cursor.fetchone()
        new_announcements = ann_row['cnt'] if ann_row else 0

        conn.close()
        return jsonify({
            "success": True,
            "stats": {
                "attendance_pct": att_pct,
                "avg_marks_pct": avg_marks,
                "pending_assignments": pending_assignments,
                "new_announcements": new_announcements,
                "total_attendance": total_att,
                "low_attendance": att_pct < 75 and total_att > 0
            }
        })
    except Exception as e:
        logger.error(f"Dashboard stats error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500


@app.route('/api/student/update_profile/<int:user_id>', methods=['PUT'])
def update_profile(user_id):
    """Updates email and phone for a user."""
    try:
        data = request.get_json()
        email = data.get('email', '').strip()
        phone = data.get('phone', '').strip()
        name = data.get('name', '').strip()

        if not email:
            return jsonify({"success": False, "message": "Email is required"}), 400

        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()

        cursor.execute('''
            UPDATE users SET email=%s, phone=%s, name=%s WHERE id=%s
        ''', (email, phone, name, user_id))
        conn.commit()

        # Return updated user
        cursor.execute('SELECT id, username, name, email, user_type, roll_number, course, semester, phone FROM users WHERE id=%s', (user_id,))
        updated_user = cursor.fetchone()
        conn.close()

        return jsonify({"success": True, "message": "Profile updated successfully", "user": dict(updated_user) if updated_user else {}})
    except Exception as e:
        logger.error(f"Update profile error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500


@app.route('/api/student/change_password', methods=['POST'])
def change_password():
    """Changes a user's password after verifying the old password."""
    try:
        data = request.get_json()
        user_id = data.get('user_id')
        old_password = data.get('old_password', '')
        new_password = data.get('new_password', '')

        if not user_id or not old_password or not new_password:
            return jsonify({"success": False, "message": "All fields are required"}), 400
        if len(new_password) < 6:
            return jsonify({"success": False, "message": "New password must be at least 6 characters"}), 400

        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()

        # Verify old password
        cursor.execute('SELECT id FROM users WHERE id=%s AND password=%s', (user_id, hash_password(old_password)))
        user = cursor.fetchone()
        if not user:
            conn.close()
            return jsonify({"success": False, "message": "Current password is incorrect"}), 400

        cursor.execute('UPDATE users SET password=%s WHERE id=%s', (hash_password(new_password), user_id))
        conn.commit()
        conn.close()

        return jsonify({"success": True, "message": "Password changed successfully"})
    except Exception as e:
        logger.error(f"Change password error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500


@app.route('/api/student/unread_announcements_count', methods=['GET'])
def unread_announcements_count():
    """Returns count of announcements from the last 7 days for notification bell."""
    try:
        conn = get_db_connection()
        if not conn:
            return jsonify({"success": False, "message": "Database connection failed"}), 500
        cursor = conn.cursor()
        cursor.execute('''
            SELECT COUNT(*) as cnt FROM announcements
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        ''')
        row = cursor.fetchone()
        conn.close()
        return jsonify({"success": True, "count": row['cnt'] if row else 0})
    except Exception as e:
        logger.error(f"Unread announcements count error: {e}")
        return jsonify({"success": False, "message": "Internal server error"}), 500


# ----------------------------
# Main Entry
# ----------------------------
if __name__ == "__main__":
    if init_database():
        logger.info("Starting Flask app...")
        app.run(debug=True, host="0.0.0.0", port=5000)
    else:
        logger.error("Failed to initialize database.")