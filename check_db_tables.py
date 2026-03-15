import sqlite3

def main():
    conn = sqlite3.connect('student_portal.db')
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
    tables = cursor.fetchall()
    print("Tables in database:", tables)
    conn.close()

if __name__ == "__main__":
    main()
