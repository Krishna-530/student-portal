# TODO for User Management Add User Form Fix

- [x] Fix addUser function in static/script.js to correctly handle student-specific fields:
  - Remove roll_number and semester from initial userData object.
  - Add roll_number, course, semester, phone only if user_type is 'student'.
- [ ] Test the Add User form for different user types (student, admin, subadmin) to ensure fields are handled correctly.
- [ ] Verify that the user is added successfully with correct data.
- [ ] Check UI for any issues related to the Add User modal and form submission.
- [ ] Review other related functions for similar issues (optional).

Next Steps:
- Test the Add User form in the running application.
- If any issues arise, debug and fix accordingly.
- Optionally, improve form validation and user feedback.

## Summary of Changes Made:
- Updated the `addUser` function in `static/script.js` to properly handle student-specific fields.
- Removed redundant/incorrect field assignments from the initial userData object.
- Ensured that roll_number, course, semester, and phone are only added when user_type is 'student'.
