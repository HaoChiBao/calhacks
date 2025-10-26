// import dotenv from 'dotenv';
// import { createClient } from '@supabase/supabase-js';

// import { UserEntry } from '../types/user';

// dotenv.config();

// // Initialize Supabase client
// const supabaseUrl = process.env.SUPABASE_URL || ''
// const supabaseKey = process.env.SUPABASE_API_KEY || ''

// if (!supabaseUrl || !supabaseKey) {
//     throw new Error('Supabase URL or API key is not defined in environment variables.');
// }

// const supabase = createClient(supabaseUrl, supabaseKey);

// const setUser = async (user: UserEntry) => {
//     // Check if the user already exists
//     const { data: existingUser, error: fetchError } = await supabase
//         .from('users')
//         .select('*')
//         .eq('id', user.id)
//         .single();

//     if (fetchError && fetchError.code !== 'PGRST116') { // Ignore "No rows found" error
//         throw new Error(`Error checking user existence: ${fetchError.message}`);
//     }

//     if (existingUser) {
//         // Update the existing user
//         const { data: updatedUser, error: updateError } = await supabase
//             .from('users')
//             .update(user)
//             .eq('id', user.id);

//         if (updateError) {
//             throw new Error(`Error updating user: ${updateError.message}`);
//         }

//         return updatedUser;
//     } else {
//         // Create a new user
//         const { data: newUser, error: insertError } = await supabase
//             .from('users')
//             .insert([user]);

//         if (insertError) {
//             throw new Error(`Error creating user: ${insertError.message}`);
//         }

//         return newUser;
//     }
// }

// const getUserById = async (id: string) => {
//     const { data, error } = await supabase
//         .from('users')
//         .select('*')
//         .eq('id', id)
//         .single();

//     if (error) {
//         if (error.code === 'PGRST116') { // "No rows found" error
//             return null;
//         }
//         throw new Error(`Error fetching user: ${error.message}`);
//     }

//     return data;
// }

// const getActiveUsers = async () => {
//     const { data, error } = await supabase
//         .from('users')
//         .select('*')
//         .eq('is_active', true);

//     if (error) {
//         throw new Error(`Error fetching active users: ${error.message}`);
//     }

//     return data;
// }

// export { setUser, getUserById, getActiveUsers };
